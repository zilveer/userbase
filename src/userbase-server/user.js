import uuidv4 from 'uuid/v4'
import connection from './connection'
import setup from './setup'
import statusCodes from './statusCodes'
import responseBuilder from './responseBuilder'
import crypto from './crypto'
import connections from './ws'
import logger from './logger'
import { validateEmail, stringToArrayBuffer } from './utils'
import appController from './app'
import adminController from './admin'

const getTtl = secondsToLive => Math.floor(Date.now() / 1000) + secondsToLive

// source: https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Session_Management_Cheat_Sheet.md#session-id-length
const ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID = 16

const VALIDATION_MESSAGE_LENGTH = 16

const HOURS_IN_A_DAY = 24
const SECONDS_IN_A_DAY = 60 * 60 * HOURS_IN_A_DAY
const MS_IN_A_DAY = 1000 * SECONDS_IN_A_DAY
const SESSION_LENGTH = MS_IN_A_DAY

const MAX_USERNAME_CHAR_LENGTH = 100

const PASSWORD_HASH_CHAR_LENGTH = 44

const MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH = 20
const MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH = 1000
const MAX_PROFILE_OBJECT_KEYS = 100

const createSession = async function (userId, appId) {
  const sessionId = crypto
    .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
    .toString('hex')

  const creationDate = new Date().toISOString()
  const session = {
    'session-id': sessionId,
    'user-id': userId,
    'app-id': appId,
    'creation-date': creationDate
  }

  const params = {
    TableName: setup.sessionsTableName,
    Item: session
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.put(params).promise()

  return { sessionId, creationDate }
}

const _buildSignUpParams = async (username, passwordSecureHash, appId, userId,
  publicKey, salts, email, profile, passwordBasedBackup) => {
  const passwordHash = await crypto.bcrypt.hash(passwordSecureHash)

  const { encryptionKeySalt, dhKeySalt, hmacKeySalt } = salts
  const { pbkdfKeySalt, passwordEncryptedSeed } = passwordBasedBackup

  const user = {
    username: username.toLowerCase(),
    'password-hash': passwordHash,
    'app-id': appId,
    'user-id': userId,
    'public-key': publicKey,
    'encryption-key-salt': encryptionKeySalt,
    'diffie-hellman-key-salt': dhKeySalt,
    'hmac-key-salt': hmacKeySalt,
    'seed-not-saved-yet': true,
    'creation-date': new Date().toISOString(),
    email: email ? email.toLowerCase() : undefined,
    profile: profile || undefined,
    'pbkdf-key-salt': pbkdfKeySalt || undefined,
    'password-encrypted-seed': passwordEncryptedSeed || undefined
  }

  return {
    TableName: setup.usersTableName,
    Item: user,
    // if username does not exist, insert
    // if it already exists and user hasn't saved seed yet, overwrite (to allow another sign up attempt)
    // if it already exists and user has saved seed, fail with ConditionalCheckFailedException
    ConditionExpression: 'attribute_not_exists(username) or attribute_exists(#seedNotSavedYet)',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet'
    }
  }
}

const _validatePassword = async (passwordSecureHash, user) => {
  if (!user || user['deleted']) throw new Error('UserNotFound')

  const passwordIsCorrect = await crypto.bcrypt.compare(passwordSecureHash, user['password-hash'])

  if (!passwordIsCorrect && !user['temp-password']) {
    throw new Error('Incorrect password')
  } else if (!passwordIsCorrect && user['temp-password']) {
    const tempPasswordIsCorrect = await crypto.bcrypt.compare(passwordSecureHash, user['temp-password'])

    if (!tempPasswordIsCorrect) {
      throw new Error('Incorrect password or temp password')
    } else {
      if (new Date() - new Date(user['temp-password-creation-date']) > MS_IN_A_DAY) {
        throw new Error('Temp password expired')
      }
    }
  }
}

const _validateProfile = (profile) => {
  if (typeof profile !== 'object') throw { error: 'ProfileMustBeObject' }

  let counter = 0
  for (const key in profile) {
    if (typeof key !== 'string') throw { error: 'ProfileKeyMustBeString', key }
    if (key.length > MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH) {
      throw { error: 'ProfileKeyTooLong', key, maxLen: MAX_PROFILE_OBJECT_KEY_CHAR_LENGTH }
    }

    const value = profile[key]
    if (value) {
      if (typeof value !== 'string') throw { error: 'ProfileValueMustBeString', key, value }
      if (value.length > MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH) {
        throw { error: 'ProfileValueTooLong', key, value, maxLen: MAX_PROFILE_OBJECT_VALUE_CHAR_LENGTH }
      }
    }

    counter += 1
    if (counter > MAX_PROFILE_OBJECT_KEYS) {
      throw { error: 'ProfileHasTooManyKeys', maxKeys: MAX_PROFILE_OBJECT_KEYS }
    }
  }

  if (!counter) throw { error: 'ProfileCannotBeEmpty' }
}

const _validatePasswordInput = (passwordSecureHash) => {
  if (typeof passwordSecureHash !== 'string') throw {
    error: 'PasswordHashMustBeString'
  }

  if (passwordSecureHash.length !== PASSWORD_HASH_CHAR_LENGTH) throw {
    error: 'PasswordHashMustBeCorrectLength',
    len: PASSWORD_HASH_CHAR_LENGTH
  }
}

const _validateUsernameInput = (username) => {
  if (typeof username !== 'string') throw {
    error: 'UsernameMustBeString'
  }

  if (username.length > MAX_USERNAME_CHAR_LENGTH) throw {
    error: 'UsernameTooLong',
    maxLen: MAX_USERNAME_CHAR_LENGTH
  }
}

const _validateUsernameAndPasswordInput = (username, passwordSecureHash) => {
  _validateUsernameInput(username)
  _validatePasswordInput(passwordSecureHash)
}

exports.signUp = async function (req, res) {
  const appId = req.query.appId

  const username = req.body.username
  const passwordSecureHash = req.body.passwordSecureHash

  const publicKey = req.body.publicKey
  const encryptionKeySalt = req.body.encryptionKeySalt
  const dhKeySalt = req.body.dhKeySalt
  const hmacKeySalt = req.body.hmacKeySalt

  const email = req.body.email
  const profile = req.body.profile

  const pbkdfKeySalt = req.body.pbkdfKeySalt
  const passwordEncryptedSeed = req.body.passwordEncryptedSeed

  if (!appId || !username || !passwordSecureHash || !publicKey || !encryptionKeySalt || !dhKeySalt || !hmacKeySalt) {
    return res.status(statusCodes['Bad Request']).send('Missing required items')
  }

  try {
    _validateUsernameAndPasswordInput(username, passwordSecureHash)

    if (email && !validateEmail(email)) return res.status(statusCodes['Bad Request'])
      .send({ error: 'EmailNotValid' })

    if (profile) _validateProfile(profile)
  } catch (e) {
    return res.status(statusCodes['Bad Request']).send(e)
  }

  try {
    const userId = uuidv4()

    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const salts = { encryptionKeySalt, dhKeySalt, hmacKeySalt }
    const passwordBasedBackup = { pbkdfKeySalt, passwordEncryptedSeed }

    const params = await _buildSignUpParams(username, passwordSecureHash, appId, userId,
      publicKey, salts, email, profile, passwordBasedBackup)

    try {
      const ddbClient = connection.ddbClient()
      await ddbClient.put(params).promise()
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') {
        return res.status(statusCodes['Conflict']).send('UsernameAlreadyExists')
      }
      throw e
    }

    const session = await createSession(userId, appId)
    return res.send(session)
  } catch (e) {
    logger.warn(`Failed to sign up user '${username}' of app '${appId}' with ${e}`)
    return res.status(statusCodes['Internal Server Error']).end()
  }
}

exports.authenticateUser = async function (req, res, next) {
  const sessionId = req.query.sessionId
  const appId = req.query.appId

  if (!sessionId || !appId) return res
    .status(statusCodes['Unauthorized'])
    .send('Missing session token or app id')

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    const sessionResponse = await ddbClient.get(params).promise()

    const session = sessionResponse.Item

    const doesNotExist = !session
    const invalidated = doesNotExist || session.invalidated

    const sessionStartDate = invalidated || new Date(session['extended-date'] || session['creation-date'])
    const expired = invalidated || new Date() - sessionStartDate > SESSION_LENGTH

    const isNotUserSession = expired || !session['user-id']

    if (doesNotExist || invalidated || expired || isNotUserSession) return res
      .status(statusCodes['Unauthorized']).send('Session invalid')

    const appDoesNotMatch = isNotUserSession || session['app-id'] !== appId
    if (appDoesNotMatch) return res
      .status(statusCodes['Unauthorized']).send('App ID not valid')

    // Warning: uses secondary indexes here. It's possible index won't be up to date and this fails
    const [user, app] = await Promise.all([
      getUserByUserId(session['user-id']),
      appController.getAppByAppId(session['app-id'])
    ])

    if (!user || user['deleted']) return res.status(statusCodes['Unauthorized']).send('Session invalid')
    if (!app || app['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    res.locals.user = user // makes user object available in next route
    next()
  } catch (e) {
    logger.error(`Failed to authenticate user session ${sessionId} with ${e}`)
    return res
      .status(statusCodes['Internal Server Error'])
      .send('Failed to authenticate user')
  }
}

exports.getValidationMessage = (publicKey) => {
  const validationMessage = crypto.randomBytes(VALIDATION_MESSAGE_LENGTH)

  const publicKeyArrayBuffer = Buffer.from(publicKey, 'base64')
  const sharedSecret = crypto.diffieHellman.computeSecret(publicKeyArrayBuffer)
  const sharedKey = crypto.sha256.hash(sharedSecret)
  const encryptedValidationMessage = crypto.aesGcm.encrypt(sharedKey, validationMessage)

  return {
    validationMessage,
    encryptedValidationMessage
  }
}

const userSavedSeed = async function (userId, appId, username, publicKey) {
  const updateUserParams = {
    TableName: setup.usersTableName,
    Key: {
      'username': username,
      'app-id': appId
    },
    UpdateExpression: 'remove #seedNotSavedYet',
    ConditionExpression: 'attribute_exists(#seedNotSavedYet) and #userId = :userId and #publicKey = :publicKey',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet',
      '#userId': 'user-id',
      '#publicKey': 'public-key'
    },
    ExpressionAttributeValues: {
      ':userId': userId,
      ':publicKey': publicKey
    },
  }

  const ddbClient = connection.ddbClient()
  await ddbClient.update(updateUserParams).promise()
}

exports.validateKey = async function (validationMessage, userProvidedValidationMessage, user, conn) {
  const seedNotSavedYet = user['seed-not-saved-yet']
  const userId = user['user-id']
  const appId = user['app-id']
  const username = user['username']
  const userPublicKey = user['public-key']

  if (validationMessage.toString('base64') === userProvidedValidationMessage) {
    try {
      if (seedNotSavedYet) {
        try {
          await userSavedSeed(userId, appId, username, userPublicKey)
        } catch (e) {
          if (e.name === 'ConditionalCheckFailedException') {
            return responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Invalid seed')
          }

          throw e
        }
      } else {
        // must be validating after requesting the seed. Clean up for safety --
        // no need to keep storing this seed request in DDB
        if (conn.requesterPublicKey) await deleteSeedRequest(userId, conn)
      }

      conn.validateKey()

      return responseBuilder.successResponse('Success!')
    } catch (e) {
      logger.error(`Failed to validate key with ${e}`)
      return responseBuilder.errorResponse(
        statusCodes['Internal Server Error'],
        'Failed to validate key'
      )
    }
  } else {
    return responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Failed to validate key')
  }
}

exports.signIn = async function (req, res) {
  const appId = req.query.appId

  const username = req.body.username
  const passwordSecureHash = req.body.passwordSecureHash

  if (!appId || !username || !passwordSecureHash) return res
    .status(statusCodes['Bad Request'])
    .send('Missing required items')

  try {
    _validateUsernameAndPasswordInput(username, passwordSecureHash)
  } catch (e) {
    return res.status(statusCodes['Bad Request']).send(e)
  }

  try {
    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const params = {
      TableName: setup.usersTableName,
      Key: {
        username: username.toLowerCase(),
        'app-id': appId
      },
    }

    const ddbClient = connection.ddbClient()
    const userResponse = await ddbClient.get(params).promise()

    const user = userResponse.Item

    try {
      await _validatePassword(passwordSecureHash, user)
    } catch (e) {
      return res.status(statusCodes['Unauthorized']).send('Invalid password')
    }

    const session = await createSession(user['user-id'], appId)

    const result = { session }

    if (user['email']) result.email = user['email']
    if (user['profile']) result.profile = user['profile']
    if (user['pbkdf-key-salt'] && user['password-encrypted-seed']) result.passwordBasedBackup = {
      pbkdfKeySalt: user['pbkdf-key-salt'],
      passwordEncryptedSeed: user['password-encrypted-seed']
    }

    return res.send(result)
  } catch (e) {
    logger.error(`Username '${username}' failed to sign in with ${e}`)
    return res.status(statusCodes['Internal Server Error']).end()
  }
}

exports.signOut = async function (sessionId) {
  if (!sessionId) return responseBuilder.errorResponse(
    statusCodes['Unauthorized'],
    'Missing session id'
  )

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    },
    UpdateExpression: 'set invalidated = :invalidated',
    ExpressionAttributeValues: {
      ':invalidated': true,
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    logger.error(`Failed to sign out session ${sessionId} with ${e}`)
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      'Failed to sign out!'
    )
  }
}

exports.requestSeed = async function (userId, senderPublicKey, connectionId, requesterPublicKey) {
  if (!requesterPublicKey) return responseBuilder.errorResponse(
    statusCodes['Bad Request'],
    'Missing requester public key'
  )

  const seedExchangeKey = {
    'user-id': userId,
    'requester-public-key': requesterPublicKey
  }

  const params = {
    TableName: setup.seedExchangeTableName,
    Item: {
      ...seedExchangeKey,
      ttl: getTtl(SECONDS_IN_A_DAY)
    },
    // do not overwrite if already exists. especially important if encrypted-seed already exists,
    // but no need to overwrite ever
    ConditionExpression: 'attribute_not_exists(#userId)',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    }
  }

  try {
    const ddbClient = connection.ddbClient()

    try {
      await ddbClient.put(params).promise()
      connections.sendSeedRequest(userId, connectionId, requesterPublicKey)
    } catch (e) {

      if (e.name === 'ConditionalCheckFailedException') {

        const existingSeedExchangeParams = {
          TableName: setup.seedExchangeTableName,
          Key: seedExchangeKey
        }

        const existingSeedExchangeResponse = await ddbClient.get(existingSeedExchangeParams).promise()
        const existingSeedExchange = existingSeedExchangeResponse.Item

        const encryptedSeed = existingSeedExchange['encrypted-seed']
        if (encryptedSeed) {
          return responseBuilder.successResponse({ senderPublicKey, encryptedSeed })
        } else {
          connections.sendSeedRequest(userId, connectionId, requesterPublicKey)
        }

      } else {
        throw e
      }
    }

    return responseBuilder.successResponse('Successfully sent out request for seed!')
  } catch (e) {
    logger.error(`Failed to request seed for user ${userId} with ${e}`)
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      `Failed to request seed with ${e}`
    )
  }
}

exports.querySeedRequests = async function (userId) {
  const params = {
    TableName: setup.seedExchangeTableName,
    KeyName: '#userId',
    KeyConditionExpression: '#userId = :userId',
    FilterExpression: 'attribute_not_exists(#encryptedSeed)',
    ExpressionAttributeNames: {
      '#userId': 'user-id',
      '#encryptedSeed': 'encrypted-seed'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    },
  }

  try {
    const ddbClient = connection.ddbClient()
    const seedRequests = await ddbClient.query(params).promise()

    return responseBuilder.successResponse({ seedRequests: seedRequests.Items })
  } catch (e) {
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      `Failed to get seed requests with ${e}`
    )
  }
}

exports.sendSeed = async function (userId, senderPublicKey, requesterPublicKey, encryptedSeed) {
  if (!requesterPublicKey || !encryptedSeed) return responseBuilder.errorResponse(
    statusCodes['Bad Request'],
    'Missing required items'
  )

  const updateSeedExchangeParams = {
    TableName: setup.seedExchangeTableName,
    Key: {
      'user-id': userId,
      'requester-public-key': requesterPublicKey
    },
    UpdateExpression: 'set #encryptedSeed = :encryptedSeed',
    ExpressionAttributeNames: {
      '#encryptedSeed': 'encrypted-seed'
    },
    ExpressionAttributeValues: {
      ':encryptedSeed': encryptedSeed
    },
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateSeedExchangeParams).promise()

    connections.sendSeed(userId, senderPublicKey, requesterPublicKey, encryptedSeed)

    return responseBuilder.successResponse('Success!')
  } catch (e) {
    return responseBuilder.errorResponse(
      statusCodes['Internal Server Error'],
      `Failed to send seed with ${e}`
    )
  }
}

const deleteSeedRequest = async function (userId, conn) {
  const requesterPublicKey = conn.requesterPublicKey

  const deleteSeedExchangeParams = {
    TableName: setup.seedExchangeTableName,
    Key: {
      'user-id': userId,
      'requester-public-key': requesterPublicKey
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.delete(deleteSeedExchangeParams).promise()

    conn.deleteSeedRequest()
  } catch (e) {
    logger.warn(`Failed to delete seed request for user ${userId} and public key ${requesterPublicKey} with ${e}`)
  }
}

async function getUserByUserId(userId) {
  const params = {
    TableName: setup.usersTableName,
    IndexName: setup.userIdIndex,
    KeyConditionExpression: '#userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    },
    Select: 'ALL_ATTRIBUTES'
  }

  const ddbClient = connection.ddbClient()
  const userResponse = await ddbClient.query(params).promise()

  if (!userResponse || userResponse.Items.length === 0) return null

  if (userResponse.Items.length > 1) {
    const errorMsg = `Too many users found with id ${userId}`
    logger.fatal(errorMsg)
    throw new Error(errorMsg)
  }

  return userResponse.Items[0]
}
exports.getUserByUserId = getUserByUserId

exports.extendSession = async function (req, res) {
  const user = res.locals.user

  const sessionId = req.query.sessionId

  const extendedDate = new Date().toISOString()

  const params = {
    TableName: setup.sessionsTableName,
    Key: {
      'session-id': sessionId
    },
    UpdateExpression: 'set #extendedDate = :extendedDate',
    ExpressionAttributeNames: {
      '#extendedDate': 'extended-date'
    },
    ExpressionAttributeValues: {
      ':extendedDate': extendedDate
    }
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(params).promise()

    const result = { extendedDate }

    if (user['email']) result.email = user['email']
    if (user['profile']) result.profile = user['profile']
    if (user['pbkdf-key-salt'] && user['password-encrypted-seed']) result.passwordBasedBackup = {
      pbkdfKeySalt: user['pbkdf-key-salt'],
      passwordEncryptedSeed: user['password-encrypted-seed']
    }

    return res.send(result)
  } catch (e) {
    logger.error(`Unable to extend session ${sessionId} with: ${e}`)
    return res
      .status(statusCodes['Internal Server Error'])
      .send('Failed to extend session')
  }
}

exports.getServerPublicKey = async function (_, res) {
  try {
    return res.send(crypto.diffieHellman.getPublicKey())
  } catch (e) {
    logger.error(`Failed to get server public key with ${e}`)
    return res.status(statusCodes['Internal Server Error']).send('Failed to get server public key')
  }
}

const _getPasswordHashFromString = async (password) => {
  const passwordArrayBuffer = stringToArrayBuffer(password)
  const passwordSecureHash = crypto.sha256.hash(passwordArrayBuffer).toString('base64')
  const passwordHash = await crypto.bcrypt.hash(passwordSecureHash)
  return passwordHash
}

const setTempPassword = async (username, appId, tempPassword) => {
  const params = {
    TableName: setup.usersTableName,
    Key: {
      username,
      'app-id': appId
    },
    UpdateExpression: 'set #tempPassword = :tempPassword, #tempPasswordCreationDate = :tempPasswordCreationDate',
    ConditionExpression: 'attribute_exists(username) and attribute_not_exists(deleted)',
    ExpressionAttributeNames: {
      '#tempPassword': 'temp-password',
      '#tempPasswordCreationDate': 'temp-password-creation-date'
    },
    ExpressionAttributeValues: {
      ':tempPassword': await _getPasswordHashFromString(tempPassword),
      ':tempPasswordCreationDate': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  }

  const ddbClient = connection.ddbClient()

  try {
    const userResponse = await ddbClient.update(params).promise()
    return userResponse.Attributes
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return null
    }
    throw e
  }
}

exports.forgotPassword = async function (req, res) {
  const appId = req.query.appId
  const username = req.body.username && req.body.username.toLowerCase()

  if (!appId || !username) return res
    .status(statusCodes['Bad Request'])
    .send('Missing required items')

  try {
    // Warning: uses secondary index here. It's possible index won't be up to date and this fails
    const app = await appController.getAppByAppId(appId)
    if (!app || app['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const admin = await adminController.findAdminByAdminId(app['admin-id'])
    if (!admin || admin['deleted']) return res.status(statusCodes['Unauthorized']).send('App ID not valid')

    const tempPassword = crypto
      .randomBytes(ACCEPTABLE_RANDOM_BYTES_FOR_SAFE_SESSION_ID)
      .toString('base64')

    const user = await setTempPassword(username, appId, tempPassword)
    if (!user) return res.status(statusCodes['Not Found']).send('UserNotFound')

    const email = user['email']
    if (!email) return res.status(statusCodes['Not Found']).send('UserEmailNotFound')

    const subject = `Forgot password - ${app['app-name']}`
    const body = `Hello, ${username}!`
      + '<br />'
      + '<br />'
      + `Someone has requested you forgot your password to ${app['app-name']}!`
      + '<br />'
      + '<br />'
      + 'If you did not make this request, you can safely ignore this email.'
      + '<br />'
      + '<br />'
      + `Here is your temporary password you can use to log in: ${tempPassword}`
      + '<br />'
      + '<br />'
      + `This password will expire in ${HOURS_IN_A_DAY} hours.`

    await setup.sendEmail(email, subject, body)

    return res.end()
  } catch (e) {
    logger.error(`Failed to forget password for user '${username}' of app '${appId}' with ${e}`)
    return res.status(statusCodes['Internal Server Error']).send('Failed to forget password')
  }
}

const _updateUserExcludingUsernameUpdate = async (user, userId, passwordSecureHash, email, profile, passwordBasedBackup) => {
  const updateUserParams = conditionCheckUserExists(user['username'], user['app-id'], userId)

  let UpdateExpression = ''

  if (passwordSecureHash || email || profile) {
    UpdateExpression = 'SET '

    if (passwordSecureHash) {
      UpdateExpression += '#passwordHash = :passwordHash'
      updateUserParams.ExpressionAttributeNames['#passwordHash'] = 'password-hash'
      updateUserParams.ExpressionAttributeValues[':passwordHash'] = await crypto.bcrypt.hash(passwordSecureHash)
    }

    if (email) {
      UpdateExpression += (passwordSecureHash ? ', ' : '') + 'email = :email'
      updateUserParams.ExpressionAttributeValues[':email'] = email.toLowerCase()
    }

    if (profile) {
      UpdateExpression += ((passwordSecureHash || email) ? ', ' : '') + 'profile = :profile'
      updateUserParams.ExpressionAttributeValues[':profile'] = profile
    }

    if (passwordBasedBackup) {
      UpdateExpression += ', #pbkdfKeySalt = :pbkdfKeySalt, #passwordEncryptedSeed = :passwordEncryptedSeed'

      updateUserParams.ExpressionAttributeNames['#pbkdfKeySalt'] = 'pbkdf-key-salt'
      updateUserParams.ExpressionAttributeNames['#passwordEncryptedSeed'] = 'password-encrypted-seed'

      updateUserParams.ExpressionAttributeValues[':pbkdfKeySalt'] = passwordBasedBackup.pbkdfKeySalt
      updateUserParams.ExpressionAttributeValues[':passwordEncryptedSeed'] = passwordBasedBackup.passwordEncryptedSeed
    }
  }

  if (email === false || profile === false) {
    UpdateExpression += ' REMOVE '

    if (email === false) {
      UpdateExpression += 'email'
    }

    if (profile === false) {
      UpdateExpression += (email === false ? ', ' : '') + 'profile'
    }
  }

  updateUserParams.UpdateExpression = UpdateExpression

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.update(updateUserParams).promise()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      throw new Error('UserNotFound')
    }
    throw e
  }
}

const _updateUserIncludingUsernameUpdate = async (oldUser, userId, username, passwordSecureHash, email, profile, passwordBasedBackup) => {
  // if updating username, need to Delete existing DDB item and Put new one because username is partition key
  const deleteUserParams = conditionCheckUserExists(oldUser['username'], oldUser['app-id'], userId)

  const updatedUser = {
    ...oldUser,
    username: username.toLowerCase()
  }

  if (passwordSecureHash) updatedUser['password-hash'] = await crypto.bcrypt.hash(passwordSecureHash)

  if (email) updatedUser.email = email.toLowerCase()
  else if (email === false) delete updatedUser.email

  if (profile) updatedUser.profile = profile
  else if (profile === false) delete updatedUser.profile

  if (passwordBasedBackup) {
    updatedUser['pbkdf-key-salt'] = passwordBasedBackup.pbkdfKeySalt
    updatedUser['password-encrypted-seed'] = passwordBasedBackup.passwordEncryptedSeed
  }

  const updateUserParams = {
    TableName: setup.usersTableName,
    Item: updatedUser,
    // if username does not exist, insert
    // if it already exists and user hasn't saved seed yet, overwrite
    // if it already exists and user has saved seed, fail with ConditionalCheckFailedException
    ConditionExpression: 'attribute_not_exists(username) or attribute_exists(#seedNotSavedYet)',
    ExpressionAttributeNames: {
      '#seedNotSavedYet': 'seed-not-saved-yet'
    }
  }

  const params = {
    TransactItems: [
      { Delete: deleteUserParams },
      { Put: updateUserParams }
    ]
  }

  try {
    const ddbClient = connection.ddbClient()
    await ddbClient.transactWrite(params).promise()
  } catch (e) {
    if (e.message.includes('[ConditionalCheckFailed')) {
      throw new Error('UserNotFound')
    } else if (e.message.includes('ConditionalCheckFailed]')) {
      throw new Error('UsernameAlreadyExists')
    }
    throw e
  }
}

exports.updateUser = async function (userId, username, passwordSecureHash, email, profile, pbkdfKeySalt, passwordEncryptedSeed) {
  if (!username && !passwordSecureHash && !email && !profile && email !== false && profile !== false) {
    return responseBuilder.errorResponse(statusCodes['Bad Request'], 'Missing all params')
  }

  try {
    if (username) _validateUsernameInput(username)
    if (passwordSecureHash) _validatePasswordInput(passwordSecureHash)
    if (email && !validateEmail(email)) throw { error: 'EmailNotValid' }
    if (profile) _validateProfile(profile)
  } catch (e) {
    return responseBuilder.errorResponse(statusCodes['Bad Request'], e)
  }

  try {
    const user = await getUserByUserId(userId)
    if (!user || user['deleted']) throw new Error('UserNotFound')

    const passwordBasedBackup = user['pbkdf-key-salt'] // password-based key recovery must be enabled
      && pbkdfKeySalt && passwordEncryptedSeed && { pbkdfKeySalt, passwordEncryptedSeed }

    if (!passwordBasedBackup && passwordSecureHash) return responseBuilder
      .errorResponse(statusCodes['Bad Request'], 'Missing password-based key recovery items')

    if (username && username.toLowerCase() !== user['username']) {
      try {
        await _updateUserIncludingUsernameUpdate(user, userId, username, passwordSecureHash, email, profile, passwordBasedBackup)
      } catch (e) {

        if (e.message.includes('ConditionalCheckFailed]')) {
          return responseBuilder.errorResponse(statusCodes['Conflict'], 'UsernameAlreadyExists')
        }

        throw e
      }

    } else {
      await _updateUserExcludingUsernameUpdate(user, userId, passwordSecureHash, email, profile, passwordBasedBackup)
    }

    return responseBuilder.successResponse()
  } catch (e) {
    if (e.message === 'UserNotFound') return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')
    else if (e.message === 'UsernameAlreadyExists') return responseBuilder.errorResponse(statusCodes['Conflict'], 'UsernameAlreadyExists')

    logger.error(`Failed to update user '${userId}' with ${e}`)
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to update user')
  }
}

const deleteUser = async (username, appId, userId) => {
  const params = conditionCheckUserExists(username, appId, userId)

  params.UpdateExpression = 'set deleted = :deleted'
  params.ExpressionAttributeValues[':deleted'] = new Date().toISOString()

  const ddbClient = connection.ddbClient()
  await ddbClient.update(params).promise()
}
exports.deleteUser = deleteUser

exports.deleteUserController = async function (userId) {
  try {
    const user = await getUserByUserId(userId)
    if (!user || user['deleted']) return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')

    await deleteUser(user['username'], user['app-id'], userId)

    return responseBuilder.successResponse()
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') {
      return responseBuilder.errorResponse(statusCodes['Not Found'], 'UserNotFound')
    }

    logger.error(`Failed to delete user '${userId}' with ${e}`)
    return responseBuilder.errorResponse(statusCodes['Internal Server Error'], 'Failed to delete user')
  }
}

const conditionCheckUserExists = (username, appId, userId) => {
  return {
    TableName: setup.usersTableName,
    Key: {
      username,
      'app-id': appId
    },
    ConditionExpression: 'attribute_exists(username) and attribute_not_exists(deleted) and #userId = :userId',
    ExpressionAttributeNames: {
      '#userId': 'user-id'
    },
    ExpressionAttributeValues: {
      ':userId': userId
    }
  }
}
