import connection from './connection'
import setup from './setup'
import uuidv4 from 'uuid/v4'
import db from './db'
import logger from './logger'
import { estimateSizeOfDdbItem } from './utils'
import statusCodes from './statusCodes'

const SECONDS_BEFORE_ROLLBACK_GAP_TRIGGERED = 1000 * 10 // 10s
const TRANSACTION_SIZE_BUNDLE_TRIGGER = 1024 * 50 // 50 KB

class Connection {
  constructor(userId, socket, clientId) {
    this.userId = userId
    this.socket = socket
    this.clientId = clientId
    this.id = uuidv4()
    this.databases = {}
    this.keyValidated = false
    this.requesterPublicKey = undefined
  }

  openDatabase(databaseId, bundleSeqNo, reopenAtSeqNo) {
    this.databases[databaseId] = {
      bundleSeqNo: bundleSeqNo > 0 ? bundleSeqNo : -1,
      lastSeqNo: reopenAtSeqNo || 0,
      transactionLogSize: 0,
      init: reopenAtSeqNo !== undefined // ensures server sends the dbNameHash & key on first ever push, not reopen
    }
  }

  validateKey() {
    this.keyValidated = true
  }

  async push(databaseId, dbNameHash, dbKey, reopenAtSeqNo) {
    const database = this.databases[databaseId]
    if (!database) return

    const payload = {
      route: 'ApplyTransactions',
      transactionLog: [],
      dbId: databaseId
    }

    const reopeningDatabase = reopenAtSeqNo !== undefined

    const openingDatabase = dbNameHash && dbKey && !reopeningDatabase
    if (openingDatabase) {
      payload.dbNameHash = dbNameHash
      payload.dbKey = dbKey
    }

    let lastSeqNo = database.lastSeqNo
    const bundleSeqNo = database.bundleSeqNo

    if (bundleSeqNo > 0 && database.lastSeqNo === 0) {
      const bundle = await db.getBundle(databaseId, bundleSeqNo)
      payload.bundleSeqNo = bundleSeqNo
      payload.bundle = bundle
      lastSeqNo = bundleSeqNo
    }

    // get transactions from the last sequence number
    const params = {
      TableName: setup.transactionsTableName,
      KeyConditionExpression: "#dbId = :dbId and #seqNo > :seqNo",
      ExpressionAttributeNames: {
        "#dbId": "database-id",
        "#seqNo": "sequence-no"
      },
      ExpressionAttributeValues: {
        ":dbId": databaseId,
        ":seqNo": lastSeqNo
      }
    }

    const ddbTransactionLog = []
    try {
      const ddbClient = connection.ddbClient()
      let gapInSeqNo = false

      do {
        let transactionLogResponse = await ddbClient.query(params).promise()

        for (let i = 0; i < transactionLogResponse.Items.length && !gapInSeqNo; i++) {

          // if there's a gap in sequence numbers and past rollback buffer, rollback all transactions in gap
          gapInSeqNo = transactionLogResponse.Items[i]['sequence-no'] > lastSeqNo + 1
          const secondsSinceCreation = gapInSeqNo && new Date() - new Date(transactionLogResponse.Items[i]['creation-date'])

          // waiting gives opportunity for item to insert into DDB
          if (gapInSeqNo && secondsSinceCreation > SECONDS_BEFORE_ROLLBACK_GAP_TRIGGERED) {
            const rolledBackTransactions = await this.rollback(lastSeqNo, transactionLogResponse.Items[i]['sequence-no'], databaseId, ddbClient)

            for (let j = 0; j < rolledBackTransactions.length; j++) {

              // add transaction to the result set if have not sent it to client yet
              if (rolledBackTransactions[j]['sequence-no'] > database.lastSeqNo) {
                ddbTransactionLog.push(rolledBackTransactions[j])
              }

            }
          } else if (gapInSeqNo) {
            // at this point must stop querying for more transactions
            continue
          }

          lastSeqNo = transactionLogResponse.Items[i]['sequence-no']

          // add transaction to the result set if have not sent it to client yet
          if (transactionLogResponse.Items[i]['sequence-no'] > database.lastSeqNo) {
            ddbTransactionLog.push(transactionLogResponse.Items[i])
          }

        }

        // paginate over all results
        params.ExclusiveStartKey = transactionLogResponse.LastEvaluatedKey
      } while (params.ExclusiveStartKey && !gapInSeqNo)

    } catch (e) {
      logger.warn(`Failed to push to ${databaseId} with ${e}`)
      throw new Error(e)
    }

    if (openingDatabase && database.lastSeqNo !== 0) {
      logger.warn(`When opening database ${databaseId}, must send client entire transaction log from tip`)
      return
    }

    if (reopeningDatabase && database.lastSeqNo !== reopenAtSeqNo) {
      logger.warn(`When reopening database ${databaseId}, must send client entire transaction log from requested seq no`)
      return
    }

    if (!openingDatabase && !database.init) {
      logger.warn(`Must finish opening database ${databaseId} before sending transactions to client`)
      return
    }

    if (!ddbTransactionLog || ddbTransactionLog.length == 0) {
      if (openingDatabase || reopeningDatabase) {
        this.socket.send(JSON.stringify(payload))

        if (payload.bundle) {
          database.lastSeqNo = payload.bundleSeqNo
        }

        database.init = true
      }
      return
    }

    this.sendPayload(payload, ddbTransactionLog, database)
  }

  async rollback(lastSeqNo, thisSeqNo, databaseId, ddbClient) {
    const rolledBackTransactions = []

    for (let i = lastSeqNo + 1; i <= thisSeqNo - 1; i++) {
      const rolledbBackItem = {
        'database-id': databaseId,
        'sequence-no': i,
        'command': 'Rollback',
        'creation-date': new Date().toISOString()
      }

      const rollbackParams = {
        TableName: setup.transactionsTableName,
        Item: rolledbBackItem,
        ConditionExpression: 'attribute_not_exists(#databaseId)',
        ExpressionAttributeNames: {
          '#databaseId': 'database-id'
        }
      }

      await ddbClient.put(rollbackParams).promise()

      rolledBackTransactions.push(rolledbBackItem)
    }

    return rolledBackTransactions
  }

  sendPayload(payload, ddbTransactionLog, database) {
    let size = 0

    // only send transactions that have not been sent to client yet
    const indexOfFirstTransactionToSend = ddbTransactionLog.findIndex(transaction => {

      // check database.lastSeqNo bc could have been overwitten while DDB was paginating
      return transaction['sequence-no'] > database.lastSeqNo
    })

    if (indexOfFirstTransactionToSend === -1) return

    const transactionLog = ddbTransactionLog
      .slice(indexOfFirstTransactionToSend)
      .map(transaction => {
        size += estimateSizeOfDdbItem(transaction)

        return {
          seqNo: transaction['sequence-no'],
          command: transaction['command'],
          key: transaction['key'],
          record: transaction['record'],
          operations: transaction['operations'],
          dbId: transaction['database-id']
        }
      })

    if (transactionLog.length === 0) return

    // only send the payload if tx log starts with the next seqNo client is supposed to receive
    if (transactionLog[0]['seqNo'] !== database.lastSeqNo + 1
      && transactionLog[0]['seqNo'] !== payload.bundleSeqNo + 1) return

    if (database.transactionLogSize + size >= TRANSACTION_SIZE_BUNDLE_TRIGGER) {
      this.socket.send(JSON.stringify({ ...payload, transactionLog, buildBundle: true }))
      database.transactionLogSize = 0
    } else {
      this.socket.send(JSON.stringify({ ...payload, transactionLog }))
      database.transactionLogSize += size
    }

    // database.lastSeqNo should be strictly increasing
    database.lastSeqNo = transactionLog[transactionLog.length - 1]['seqNo']
    database.init = true
  }

  openSeedRequest(requesterPublicKey) {
    this.requesterPublicKey = requesterPublicKey
  }

  sendSeedRequest(requesterPublicKey) {
    if (!this.keyValidated) return

    const payload = {
      route: 'ReceiveRequestForSeed',
      requesterPublicKey
    }

    this.socket.send(JSON.stringify(payload))
  }

  sendSeed(senderPublicKey, requesterPublicKey, encryptedSeed) {
    if (this.requesterPublicKey !== requesterPublicKey) return

    const payload = {
      route: 'ReceiveSeed',
      encryptedSeed,
      senderPublicKey
    }

    this.socket.send(JSON.stringify(payload))
  }

  deleteSeedRequest() {
    delete this.requesterPublicKey
  }
}

export default class Connections {
  static register(userId, socket, clientId) {
    if (!Connections.sockets) Connections.sockets = {}
    if (!Connections.sockets[userId]) Connections.sockets[userId] = {}

    if (!Connections.uniqueClients) Connections.uniqueClients = {}
    if (!Connections.uniqueClients[clientId]) {
      Connections.uniqueClients[clientId] = true
    } else {
      logger.warn(`User ${userId} attempted to open multiple socket connections from client ${clientId}`)
      socket.close(statusCodes['Client Already Connected'])
      return false
    }

    const connection = new Connection(userId, socket, clientId)

    Connections.sockets[userId][connection.id] = connection
    logger.info(`Websocket ${connection.id} connected from user ${userId}`)

    return connection
  }

  static openDatabase(userId, connectionId, databaseId, bundleSeqNo, dbNameHash, dbKey, reopenAtSeqNo) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId][connectionId]) return

    const conn = Connections.sockets[userId][connectionId]

    if (!conn.databases[databaseId]) {
      conn.openDatabase(databaseId, bundleSeqNo, reopenAtSeqNo)
      logger.info(`Database ${databaseId} opened on connection ${connectionId}`)
    }

    conn.push(databaseId, dbNameHash, dbKey, reopenAtSeqNo)

    return true
  }

  static push(transaction, userId) {
    if (!Connections.sockets || !Connections.sockets[userId]) return

    for (const conn of Object.values(Connections.sockets[userId])) {
      const database = conn.databases[transaction['database-id']]

      // don't need to requery DDB if sending transaction with the next sequence no
      if (database && transaction['sequence-no'] === database.lastSeqNo + 1) {
        const payload = {
          route: 'ApplyTransactions',
          dbId: transaction['database-id']
        }

        conn.sendPayload(payload, [transaction], database)
      } else {
        conn.push(transaction['database-id'])
      }
    }
  }

  static sendSeedRequest(userId, connectionId, requesterPublicKey) {
    if (!Connections.sockets || !Connections.sockets[userId] || !Connections.sockets[userId][connectionId]) return

    const conn = Connections.sockets[userId][connectionId]
    conn.openSeedRequest(requesterPublicKey)

    for (const connection of Object.values(Connections.sockets[userId])) {
      connection.sendSeedRequest(requesterPublicKey)
    }
  }

  static sendSeed(userId, senderPublicKey, requesterPublicKey, encryptedSeed) {
    if (!Connections.sockets || !Connections.sockets[userId]) return

    for (const conn of Object.values(Connections.sockets[userId])) {
      conn.sendSeed(senderPublicKey, requesterPublicKey, encryptedSeed)
    }
  }

  static close(connection) {
    delete Connections.sockets[connection.userId][connection.id]
    delete Connections.uniqueClients[connection.clientId]
  }
}
