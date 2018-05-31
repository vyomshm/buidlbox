/* ------------------------ Node.js Dependencies ------------------------ */
const URL = require('url-parse');
/* ------------------------ External Dependencies ------------------------ */
const cookieParser = require('cookie-parser')()
const express = require('express')
const uport = require('uport')
const mnid = require('mnid')
const admin = require('firebase-admin')
const functions = require('firebase-functions')
const cors = require('cors')({origin: true})
const octokit = require('@octokit/rest')()
const Twitter = require('twitter')
/* ------------------------- Internal Dependencies -------------------------- */
const database = require('./database')
const validateFirebaseIdToken = require('./authorization')
// const TwitterClient = require('./twitter')
const serviceAccount = require('../secrets/service_account.json')

/* --------------------- Initialization & Configuration --------------------- */
/**
 * Express Server
 * @desc Initialize an express server.
 */
const app = express()
app.use(cors)
app.use(cookieParser)
app.use(validateFirebaseIdToken)

/* uPort */
const Credentials = uport.Credentials
const SimpleSigner = uport.SimpleSigner
const Contract = uport.Contract

/* MNID */
const decode = mnid.decode


/* ------------------------- Envirnonment Variables -------------------------- */
const configuration = functions.config()

// Firebase
const projectId = configuration.firebase.projectId
const databaseURL = configuration.firebase.databaseURL

// uPort
const uportAppName = configuration.uport.appname
const uportAppAddress = configuration.uport.address
const uportSimpleSignerKey = configuration.uport.simplesigner

// Twitter
const twitterConsumerKey = configuration.twitter.consumer_key
const twitterConsumerSecret = configuration.twitter.consumer_secret
const twitterTokenKey = configuration.twitter.token_key
const twitterTokenSecret = configuration.twitter.token_secret

// Github
const githubPublicKey = configuration.github.public_key
const githubSecretKey = configuration.github.private_key

/**
 * Credentials | uPort
 * @desc Initialize the uPort Credentials object to
 * request credentials and generate private attestations.
 */
const uportSimpleSigner = SimpleSigner(uportSimpleSignerKey)
const uportCredentials = new Credentials({
  appName: uportAppName,
  address: uportAppAddress,
  signer: uportSimpleSigner
})

/**
 * Client | Twitter
 * @desc Initialize the Twitter Client object to communicate with the Twitter API
 */
const TwitterClient = Twitter({
  consumer_key: twitterConsumerKey,
  consumer_secret: twitterConsumerSecret,
  access_token_key: twitterTokenKey,
  access_token_secret: twitterTokenSecret
})

/* ------------------------ Initialize Dependencies ------------------------- */
/**
 * Firebase - Administrator Initialization
 */
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: databaseURL
})
const firestore = admin.firestore()

/*---*---------------              ---------------*---* 

                  Identity Authentication

/*---*---------------              ---------------*---*/

/**
 * VerifyGithub
 * @param {object} request The HTTP request object
 * @param {object} response The HTTP response object
 * TODO(@kamescg) The current authentiction doesn't work. Need to figure out why!?
 */
const verifyGithub = (req, res) => {
  res.json({user: req.user}).send()
  octokit.authenticate({
    type: 'oauth',
    key: githubPublicKey,
    secret: githubSecretKey
  })

  octokit.users.checkFollowing({username: 'KamesCG'}).then(result => {
    console.log(result)
  })
}

/**
 * Identity
 * @desc Authenticates a uPort decentralized identity
 * @param {object} request The HTTP request object
 * @param {object} response The HTTP response object
 */
exports.identity = functions.https.onRequest((request, response) => {
  cors(request, response, () => {
    uportCredentials.receive(request.body.JWT)
    .then(profile => {
      /**
       * TODO(@kamescg) Saving the profile should be handled better.
       * During registration the information doesn't correctly appear in frontend.
       */
      if (profile.name) {
        admin.auth().updateUser(profile.address, {
          displayName: profile.name
        })
      }
      if (profile.avatar) {
        admin.auth().updateUser(profile.address, {
          photoURL: profile.avatar.uri
        })
      }
      /**
       * Generate the authentication token using the uPort MNID.
       * Send the authentication token to application fronend.
       * Save the latest credentials in the identity profile branch.
       */
      admin.auth().createCustomToken(profile.address)
      .then((AuthenticationToken) => {
        response.json(AuthenticationToken).send() // Return the AuthenticationToken to the Application Frontend
        const mnidDecoded = decode(profile.address)
        // Save Profile in Realtime Database
        database.databaseWrite({
          writeType: 'update',
          branch: ['users', profile.address, 'profile'],
          payload: {
            ...profile,
            addressDecoded: mnidDecoded
          }
        })
        // Save Profile in Firestore (NoSQL) - Experimental
        // TODO(@kamescg) Add Firestore Redux Saga to React Frontend
        // firestore.collection('people').update(profile)
      })
      .catch(error => {
        response.send(error)
        database.databaseWrite({
          writeType: 'create',
          branch: ['errors'],
          payload: {
            data: error,
            meta: {
              type: 'firebase',
              category: 'authenticationToken'
            }
          }
        })
        console.log('Error creating Firebase authentication token:', error)
      })
    })
    .catch(error => {
      database.databaseWrite({
        writeType: 'create',
        branch: ['errors'],
        payload: {
          data: error,
          meta: {
            type: 'uport',
            category: 'authenticationToken'
          }
        }
      })
      response.send(error)
      console.log('Error authenticating uPort decentralized identity:', error)
    })
  })
})

/**
 * Identity Callback
 * @desc Callback URL for the uPort Identity
 */
exports.identityCallback = functions.https.onRequest((request, response) => {
  const UID = request.query.uid
  const accessToken = request.body.access_token
  database.databaseWrite({
    writeType: 'update',
    branch: ['request', 'login', UID, 'data'],
    payload: {
      JWT: accessToken
    }
  })
})

/**
 * Identity
 * @desc Authenticates a uPort decentralized identity
 * @param {object} request The HTTP request object
 * @param {object} response The HTTP response object
 */

app.post('/verify', (req, res) => {
  console.log(req.body)
  console.log(req.user)
  const provider = req.user.firebase.sign_in_provider
  console.log(provider)
  switch (provider) {
    case 'twitter.com':
      verifyTwitter(req, res)
      break
      case 'github.com':
      verifyGithub(req, res)
      break
    default:
      break
  }
})

exports.api = functions.https.onRequest(app)
exports.verify = functions.https.onRequest((request, response) => {
  cors(request, response, () => {
    console.log(request.body)
  })
})


/**
 * VerifyTwitter
 * @param {object} req 
 * @param {object} res 
 */
const verifyTwitter = (req, res) => {
  var params = {user_id: req.user.firebase.identities['twitter.com'][0]}
  TwitterClient.get('users/lookup', params, function (error, user, response) {
    if (!error) {
      const twitterProfile = user[0]
      uportCredentials.receive(req.body.JWT)
      .then(profile => {
        uportCredentials.attest({
          sub: profile.address,
          claim: {
            name: twitterProfile.name,
            screenName: twitterProfile.screen_name,
            url: twitterProfile.url,
            followers: twitterProfile.followers_count,
            friends: twitterProfile.friends_count,
            verified: twitterProfile.verified
          }
        })
        .then(attestation => {
          console.log(attestation)
          const url = `me.uport:add?attestations=${attestation}`
          uportCredentials.push(profile.pushToken, profile.publicEncKey, {url}).then(response => {
            database.databaseWrite({
              writeType: 'push',
              branch: ['request', 'verification'],
              payload: {
                ...response
              }
            })
          })
        }).catch(err => {
          database.databaseWrite({
            writeType: 'update',
            branch: ['request', 'verifcation', 'error'],
            payload: {
              ...err
            }
          })
        })
      })
    } else {
      console.log(error)
    }
  })
  
  database.databaseWrite({
    writeType: 'push',
    branch: ['request', 'verify'],
    payload: {
      data: req.user,
      meta: {
        status: 'verified',
        category: 'twitter',
        type: 'verify'
      }
    }
  })
  res.json({user: req.user}).send()
}

/*---*---------------              ---------------*---* 

                    Database Requests

/*---*---------------              ---------------*---*/

/**
 * Manage Attestation Requests
 * TODO(@kamescg): Better Attestation Verification database naming structure.
 * 
 * Currently the '/request/attestation/' path is montired for database changes.
 * This is just a starting point and MVP for data streaming between frontend/backend
 *  
 * The process needs to be more thoroughly thought about to fully understand how we
 * can enable as many verifiatons systems to "hook" into our private verification attestation
 * framework/boilerplate. 
 */

exports.request = functions.database.ref('/request/{type}/{request}')
  .onCreate(event => {
    const eventKey = event.data.key
    const eventData = event.data.val()
    if (eventData.meta.status) {
      switch (eventData.meta.status) {
        case ('initialized'):
          switch (eventData.meta.type) {
            case ('login'):
              return loginGenerate(eventData, eventKey)
            case ('attestation'):
              return attestationGenerate(eventData, eventKey)
            case ('function'):
              return functionGenerate(eventData, eventKey)
            default:
              // TODO(@kamescg): Handle default use case
              break
          }
          break
        default:
          // TODO(@kamescg): Handle default use case
          break
      }
    }
  })

exports.eventRequest = functions.database.ref('/events/{event}')
.onCreate(event => {
  const eventKey = event.data.key
  const eventData = event.data.val()
  if (eventData.meta.status) {
    switch (eventData.meta.status) {
      case ('initialized'):
        return eventGenerate(eventData, eventKey)
      default:
        // TODO(@kamescg): Handle default use case
        break
    }
  }
})

/**
 * @desc Generates a uPort login request using the createRequest method
 * @param {object} eventData The data saved in the Firebase realtime database.
 * @param {string} eventKey The key referencing the new realtime database entry.
 */
const loginGenerate = (eventData, eventKey) => {
  return uportCredentials.createRequest({
    requested: eventData.input.requested,
    notifications: eventData.input.notifications,
    callbackUrl: `https://us-central1-${projectId}.cloudfunctions.net/identityCallback?uid=${eventKey}`
  }).then(requestToken => {
    database.databaseWrite({
      writeType: 'update',
      branch: ['request', 'login', eventKey],
      payload: {
        data: {
          qr: `me.uport:me?requestToken=${requestToken}`
        },
        meta: {
          status: 'requested',
          type: 'login'
        }
      }
    })
  })
}

/**
 * @desc Generates a uPort attestation using the attest method
 * @param {object} eventData The data saved in the Firebase realtime database.
 * @param {string} eventKey The key referencing the new realtime database entry.
 */
const attestationGenerate = (eventData, eventKey) => {
  return database.databaseSearch({
    branch: ['users'],
    boundaries: {
      child: eventData.meta.uid
    }
  }).then(lookup => {
    uportCredentials.attest({
      sub: lookup[0].address,
      claim: {
        ...eventData.data
      }
    }).then(attestation => {
      const url = `me.uport:add?attestations=${attestation}`
      uportCredentials.push(lookup[0].pushToken, lookup[0].publicEncKey, {url}).then(response => {
        database.databaseWrite({
          writeType: 'update',
          branch: ['request', 'attestation', eventKey, 'meta'],
          payload: {
            ...response
          }
        })
      })
    }).catch(err => {
      database.databaseWrite({
        writeType: 'update',
        branch: ['request', 'attestation', eventKey, 'error'],
        payload: {
          ...err
        }
      })
    })
  })
}

/**
 * @desc Generates a uPort login request using the createRequest method
 * @param {object} eventData The data saved in the Firebase realtime database.
 * @param {string} eventKey The key referencing the new realtime database entry.
 * 
 * me.uport:WPivvsQ?function=approve(address%20ERC20Approve%2C%20uint256%204)&label=Eidenai&callback_url=https%3A%2F%2Fchasqui.uport.me%2Fapi%2Fv1%2Ftopic%2Fo6OyEDhb6V9McMhh&client_id=2oo7fQjxR44MnKa8n4XKDZBBa2Buty4qrug
 */
const functionGenerate = (eventData, eventKey) => {
  return database.databaseSearch({
    branch: ['users'],
    boundaries: {
      child: eventData.meta.uid
    }
  })
  .then(lookup => {
    const contractAddress = '0xa4e8acb31c42be108c12a7f61343f3688d561633'
    const contractInstance = Contract(ERC20.abi)
    const contract = contractInstance.at(contractAddress)
    const url = contract.transfer('0xa4e8acb31c42be108c12a7f61343f3688d561625', 5)
    // const url = 'me.uport:WPivvsQ?function=approve(address%20ERC20Approve%2C%20uint256%204)&label=Eidenai&callback_url=https%3A%2F%2Fchasqui.uport.me%2Fapi%2Fv1%2Ftopic%2Fo6OyEDhb6V9McMhh&client_id=2oo7fQjxR44MnKa8n4XKDZBBa2Buty4qrug'
    // console.log(url)
    uportCredentials.push(lookup[0].pushToken, lookup[0].publicEncKey, {url}).then(response => {
      database.databaseWrite({
        writeType: 'update',
        branch: ['request', 'contract', eventKey, 'data'],
        payload: {
          url
        }
      })
    })
  })
}

const eventGenerate = (eventData, eventKey) => {
  uportCredentials.attest({
    sub: uportAppAddress, // The event subject is the Application MNID
    claim: {
      ...eventData.input
    }
  }).then(attestation => {
    const url = `me.uport:add?attestations=${attestation}`
    database.databaseWrite({
      writeType: 'update',
      branch: ['events', eventKey, 'data'],
      payload: {
        QR: url
      }
    })
  }).catch(err => {
    database.databaseWrite({
      writeType: 'update',
      branch: ['events', eventKey, 'error'],
      payload: {
        ...err
      }
    })
  })
}

/*---*---------------              ---------------*---* 

                      Authentication 

/*---*---------------              ---------------*---*/
exports.authenticationComplete = functions.auth.user().onCreate(event => {
  const providerAccountType = {
    'google.com': 'google',
    'github.com': 'github',
    'twitter.com': 'twitter',
    'facebook.com': 'facebook'
  }[event.data.providerData.providerId]
  const person = {
    eid: event.data.uid,
    images: {
      imageProfile: event.data.photoURL
    },
    name: {
      nameDisplay: event.data.displayName
    },
    contact: {
      contactEmail: event.data.email
    },
    metadata: {
      metadataAccountType: providerAccountType || false
    },
    provider: event.data.providerData
  }
  firestore.collection('people').add(person)
})

const ERC20 = {
  "contractName": "EIP20",
  "abi": [
    {
      "constant": true,
      "inputs": [],
      "name": "name",
      "outputs": [
        {
          "name": "",
          "type": "string"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "totalSupply",
      "outputs": [
        {
          "name": "",
          "type": "uint256"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [
        {
          "name": "",
          "type": "address"
        }
      ],
      "name": "balances",
      "outputs": [
        {
          "name": "",
          "type": "uint256"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "decimals",
      "outputs": [
        {
          "name": "",
          "type": "uint8"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [
        {
          "name": "",
          "type": "address"
        },
        {
          "name": "",
          "type": "address"
        }
      ],
      "name": "allowed",
      "outputs": [
        {
          "name": "",
          "type": "uint256"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [],
      "name": "symbol",
      "outputs": [
        {
          "name": "",
          "type": "string"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "inputs": [
        {
          "name": "_initialAmount",
          "type": "uint256"
        },
        {
          "name": "_tokenName",
          "type": "string"
        },
        {
          "name": "_decimalUnits",
          "type": "uint8"
        },
        {
          "name": "_tokenSymbol",
          "type": "string"
        }
      ],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "constructor"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "name": "_from",
          "type": "address"
        },
        {
          "indexed": true,
          "name": "_to",
          "type": "address"
        },
        {
          "indexed": false,
          "name": "_value",
          "type": "uint256"
        }
      ],
      "name": "Transfer",
      "type": "event"
    },
    {
      "anonymous": false,
      "inputs": [
        {
          "indexed": true,
          "name": "_owner",
          "type": "address"
        },
        {
          "indexed": true,
          "name": "_spender",
          "type": "address"
        },
        {
          "indexed": false,
          "name": "_value",
          "type": "uint256"
        }
      ],
      "name": "Approval",
      "type": "event"
    },
    {
      "constant": false,
      "inputs": [
        {
          "name": "_to",
          "type": "address"
        },
        {
          "name": "_value",
          "type": "uint256"
        }
      ],
      "name": "transfer",
      "outputs": [
        {
          "name": "success",
          "type": "bool"
        }
      ],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "constant": false,
      "inputs": [
        {
          "name": "_from",
          "type": "address"
        },
        {
          "name": "_to",
          "type": "address"
        },
        {
          "name": "_value",
          "type": "uint256"
        }
      ],
      "name": "transferFrom",
      "outputs": [
        {
          "name": "success",
          "type": "bool"
        }
      ],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [
        {
          "name": "_owner",
          "type": "address"
        }
      ],
      "name": "balanceOf",
      "outputs": [
        {
          "name": "balance",
          "type": "uint256"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    },
    {
      "constant": false,
      "inputs": [
        {
          "name": "_spender",
          "type": "address"
        },
        {
          "name": "_value",
          "type": "uint256"
        }
      ],
      "name": "approve",
      "outputs": [
        {
          "name": "success",
          "type": "bool"
        }
      ],
      "payable": false,
      "stateMutability": "nonpayable",
      "type": "function"
    },
    {
      "constant": true,
      "inputs": [
        {
          "name": "_owner",
          "type": "address"
        },
        {
          "name": "_spender",
          "type": "address"
        }
      ],
      "name": "allowance",
      "outputs": [
        {
          "name": "remaining",
          "type": "uint256"
        }
      ],
      "payable": false,
      "stateMutability": "view",
      "type": "function"
    }
  ],
  "bytecode": "0x6060604052341561000f57600080fd5b604051610dd1380380610dd18339810160405280805190602001909190805182019190602001805190602001909190805182019190505083600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508360008190555082600390805190602001906100a79291906100e3565b5081600460006101000a81548160ff021916908360ff16021790555080600590805190602001906100d99291906100e3565b5050505050610188565b828054600181600116156101000203166002900490600052602060002090601f016020900481019282601f1061012457805160ff1916838001178555610152565b82800160010185558215610152579182015b82811115610151578251825591602001919060010190610136565b5b50905061015f9190610163565b5090565b61018591905b80821115610181576000816000905550600101610169565b5090565b90565b610c3a806101976000396000f3006060604052600436106100af576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806306fdde03146100b4578063095ea7b31461014257806318160ddd1461019c57806323b872dd146101c557806327e235e31461023e578063313ce5671461028b5780635c658165146102ba57806370a082311461032657806395d89b4114610373578063a9059cbb14610401578063dd62ed3e1461045b575b600080fd5b34156100bf57600080fd5b6100c76104c7565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156101075780820151818401526020810190506100ec565b50505050905090810190601f1680156101345780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b341561014d57600080fd5b610182600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610565565b604051808215151515815260200191505060405180910390f35b34156101a757600080fd5b6101af610657565b6040518082815260200191505060405180910390f35b34156101d057600080fd5b610224600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803590602001909190505061065d565b604051808215151515815260200191505060405180910390f35b341561024957600080fd5b610275600480803573ffffffffffffffffffffffffffffffffffffffff169060200190919050506108f7565b6040518082815260200191505060405180910390f35b341561029657600080fd5b61029e61090f565b604051808260ff1660ff16815260200191505060405180910390f35b34156102c557600080fd5b610310600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610922565b6040518082815260200191505060405180910390f35b341561033157600080fd5b61035d600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610947565b6040518082815260200191505060405180910390f35b341561037e57600080fd5b610386610990565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156103c65780820151818401526020810190506103ab565b50505050905090810190601f1680156103f35780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b341561040c57600080fd5b610441600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610a2e565b604051808215151515815260200191505060405180910390f35b341561046657600080fd5b6104b1600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610b87565b6040518082815260200191505060405180910390f35b60038054600181600116156101000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004801561055d5780601f106105325761010080835404028352916020019161055d565b820191906000526020600020905b81548152906001019060200180831161054057829003601f168201915b505050505081565b600081600260003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508273ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925846040518082815260200191505060405180910390a36001905092915050565b60005481565b600080600260008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054905082600160008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020541015801561072e5750828110155b151561073957600080fd5b82600160008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254019250508190555082600160008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825403925050819055507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8110156108865782600260008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825403925050819055505b8373ffffffffffffffffffffffffffffffffffffffff168573ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef856040518082815260200191505060405180910390a360019150509392505050565b60016020528060005260406000206000915090505481565b600460009054906101000a900460ff1681565b6002602052816000526040600020602052806000526040600020600091509150505481565b6000600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b60058054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015610a265780601f106109fb57610100808354040283529160200191610a26565b820191906000526020600020905b815481529060010190602001808311610a0957829003601f168201915b505050505081565b600081600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205410151515610a7e57600080fd5b81600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254039250508190555081600160008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825401925050819055508273ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040518082815260200191505060405180910390a36001905092915050565b6000600260008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050929150505600a165627a7a72305820c2fe17d3929903ad8d126aa5abcae1dde074134a5af3603f02cc26ce6a9f0c900029",
  "deployedBytecode": "0x6060604052600436106100af576000357c0100000000000000000000000000000000000000000000000000000000900463ffffffff16806306fdde03146100b4578063095ea7b31461014257806318160ddd1461019c57806323b872dd146101c557806327e235e31461023e578063313ce5671461028b5780635c658165146102ba57806370a082311461032657806395d89b4114610373578063a9059cbb14610401578063dd62ed3e1461045b575b600080fd5b34156100bf57600080fd5b6100c76104c7565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156101075780820151818401526020810190506100ec565b50505050905090810190601f1680156101345780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b341561014d57600080fd5b610182600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610565565b604051808215151515815260200191505060405180910390f35b34156101a757600080fd5b6101af610657565b6040518082815260200191505060405180910390f35b34156101d057600080fd5b610224600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803590602001909190505061065d565b604051808215151515815260200191505060405180910390f35b341561024957600080fd5b610275600480803573ffffffffffffffffffffffffffffffffffffffff169060200190919050506108f7565b6040518082815260200191505060405180910390f35b341561029657600080fd5b61029e61090f565b604051808260ff1660ff16815260200191505060405180910390f35b34156102c557600080fd5b610310600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610922565b6040518082815260200191505060405180910390f35b341561033157600080fd5b61035d600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610947565b6040518082815260200191505060405180910390f35b341561037e57600080fd5b610386610990565b6040518080602001828103825283818151815260200191508051906020019080838360005b838110156103c65780820151818401526020810190506103ab565b50505050905090810190601f1680156103f35780820380516001836020036101000a031916815260200191505b509250505060405180910390f35b341561040c57600080fd5b610441600480803573ffffffffffffffffffffffffffffffffffffffff16906020019091908035906020019091905050610a2e565b604051808215151515815260200191505060405180910390f35b341561046657600080fd5b6104b1600480803573ffffffffffffffffffffffffffffffffffffffff1690602001909190803573ffffffffffffffffffffffffffffffffffffffff16906020019091905050610b87565b6040518082815260200191505060405180910390f35b60038054600181600116156101000203166002900480601f01602080910402602001604051908101604052809291908181526020018280546001816001161561010002031660029004801561055d5780601f106105325761010080835404028352916020019161055d565b820191906000526020600020905b81548152906001019060200180831161054057829003601f168201915b505050505081565b600081600260003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020819055508273ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167f8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925846040518082815260200191505060405180910390a36001905092915050565b60005481565b600080600260008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002054905082600160008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020541015801561072e5750828110155b151561073957600080fd5b82600160008673ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254019250508190555082600160008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825403925050819055507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8110156108865782600260008773ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825403925050819055505b8373ffffffffffffffffffffffffffffffffffffffff168573ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef856040518082815260200191505060405180910390a360019150509392505050565b60016020528060005260406000206000915090505481565b600460009054906101000a900460ff1681565b6002602052816000526040600020602052806000526040600020600091509150505481565b6000600160008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050919050565b60058054600181600116156101000203166002900480601f016020809104026020016040519081016040528092919081815260200182805460018160011615610100020316600290048015610a265780601f106109fb57610100808354040283529160200191610a26565b820191906000526020600020905b815481529060010190602001808311610a0957829003601f168201915b505050505081565b600081600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000205410151515610a7e57600080fd5b81600160003373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020016000206000828254039250508190555081600160008573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020600082825401925050819055508273ffffffffffffffffffffffffffffffffffffffff163373ffffffffffffffffffffffffffffffffffffffff167fddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef846040518082815260200191505060405180910390a36001905092915050565b6000600260008473ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff16815260200190815260200160002060008373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff168152602001908152602001600020549050929150505600a165627a7a72305820c2fe17d3929903ad8d126aa5abcae1dde074134a5af3603f02cc26ce6a9f0c900029",
  "sourceMap": "161:2566:1:-;;;872:638;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1050:14;1027:8;:20;1036:10;1027:20;;;;;;;;;;;;;;;:37;;;;1141:14;1127:11;:28;;;;1218:10;1211:4;:17;;;;;;;;;;;;:::i;:::-;;1320:13;1309:8;;:24;;;;;;;;;;;;;;;;;;1422:12;1413:6;:21;;;;;;;;;;;;:::i;:::-;;872:638;;;;161:2566;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::i;:::-;;;:::o;:::-;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;:::-;;;;;;;",
  "deployedSourceMap": "161:2566:1:-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;663:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;23:1:-1;8:100;33:3;30:1;27:2;8:100;;;99:1;94:3;90;84:5;80:1;75:3;71;64:6;52:2;49:1;45:3;40:15;;8:100;;;12:14;3:109;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2369:205:1;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;620:26:3;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1792:452:1;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;256:44;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;734:21;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;306:64;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2250:113;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;805:20;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;23:1:-1;8:100;33:3;30:1;27:2;8:100;;;99:1;94:3;90;84:5;80:1;75:3;71;64:6;52:2;49:1;45:3;40:15;;8:100;;;12:14;3:109;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;1516:270:1;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;2580:142;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;663:18;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;2369:205::-;2436:12;2492:6;2460:7;:19;2468:10;2460:19;;;;;;;;;;;;;;;:29;2480:8;2460:29;;;;;;;;;;;;;;;:38;;;;2529:8;2508:38;;2517:10;2508:38;;;2539:6;2508:38;;;;;;;;;;;;;;;;;;2563:4;2556:11;;2369:205;;;;:::o;620:26:3:-;;;;:::o;1792:452:1:-;1874:12;1898:17;1918:7;:14;1926:5;1918:14;;;;;;;;;;;;;;;:26;1933:10;1918:26;;;;;;;;;;;;;;;;1898:46;;1981:6;1962:8;:15;1971:5;1962:15;;;;;;;;;;;;;;;;:25;;:48;;;;;2004:6;1991:9;:19;;1962:48;1954:57;;;;;;;;2038:6;2021:8;:13;2030:3;2021:13;;;;;;;;;;;;;;;;:23;;;;;;;;;;;2073:6;2054:8;:15;2063:5;2054:15;;;;;;;;;;;;;;;;:25;;;;;;;;;;;240:10;2093:9;:23;2089:90;;;2162:6;2132:7;:14;2140:5;2132:14;;;;;;;;;;;;;;;:26;2147:10;2132:26;;;;;;;;;;;;;;;;:36;;;;;;;;;;;2089:90;2204:3;2188:28;;2197:5;2188:28;;;2209:6;2188:28;;;;;;;;;;;;;;;;;;2233:4;2226:11;;1792:452;;;;;;:::o;256:44::-;;;;;;;;;;;;;;;;;:::o;734:21::-;;;;;;;;;;;;;:::o;306:64::-;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;2250:113::-;2306:15;2340:8;:16;2349:6;2340:16;;;;;;;;;;;;;;;;2333:23;;2250:113;;;:::o;805:20::-;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;;:::o;1516:270::-;1579:12;1635:6;1611:8;:20;1620:10;1611:20;;;;;;;;;;;;;;;;:30;;1603:39;;;;;;;;1676:6;1652:8;:20;1661:10;1652:20;;;;;;;;;;;;;;;;:30;;;;;;;;;;;1709:6;1692:8;:13;1701:3;1692:13;;;;;;;;;;;;;;;;:23;;;;;;;;;;;1746:3;1725:33;;1734:10;1725:33;;;1751:6;1725:33;;;;;;;;;;;;;;;;;;1775:4;1768:11;;1516:270;;;;:::o;2580:142::-;2654:17;2690:7;:15;2698:6;2690:15;;;;;;;;;;;;;;;:25;2706:8;2690:25;;;;;;;;;;;;;;;;2683:32;;2580:142;;;;:::o",
  "source": "/*\nImplements EIP20 token standard: https://github.com/ethereum/EIPs/blob/master/EIPS/eip-20.md\n.*/\n\n\npragma solidity ^0.4.18;\n\nimport \"./EIP20Interface.sol\";\n\n\ncontract EIP20 is EIP20Interface {\n\n    uint256 constant private MAX_UINT256 = 2**256 - 1;\n    mapping (address => uint256) public balances;\n    mapping (address => mapping (address => uint256)) public allowed;\n    /*\n    NOTE:\n    The following variables are OPTIONAL vanities. One does not have to include them.\n    They allow one to customise the token contract & in no way influences the core functionality.\n    Some wallets/interfaces might not even bother to look at this information.\n    */\n    string public name;                   //fancy name: eg Simon Bucks\n    uint8 public decimals;                //How many decimals to show.\n    string public symbol;                 //An identifier: eg SBX\n\n    function EIP20(\n        uint256 _initialAmount,\n        string _tokenName,\n        uint8 _decimalUnits,\n        string _tokenSymbol\n    ) public {\n        balances[msg.sender] = _initialAmount;               // Give the creator all initial tokens\n        totalSupply = _initialAmount;                        // Update total supply\n        name = _tokenName;                                   // Set the name for display purposes\n        decimals = _decimalUnits;                            // Amount of decimals for display purposes\n        symbol = _tokenSymbol;                               // Set the symbol for display purposes\n    }\n\n    function transfer(address _to, uint256 _value) public returns (bool success) {\n        require(balances[msg.sender] >= _value);\n        balances[msg.sender] -= _value;\n        balances[_to] += _value;\n        Transfer(msg.sender, _to, _value);\n        return true;\n    }\n\n    function transferFrom(address _from, address _to, uint256 _value) public returns (bool success) {\n        uint256 allowance = allowed[_from][msg.sender];\n        require(balances[_from] >= _value && allowance >= _value);\n        balances[_to] += _value;\n        balances[_from] -= _value;\n        if (allowance < MAX_UINT256) {\n            allowed[_from][msg.sender] -= _value;\n        }\n        Transfer(_from, _to, _value);\n        return true;\n    }\n\n    function balanceOf(address _owner) public view returns (uint256 balance) {\n        return balances[_owner];\n    }\n\n    function approve(address _spender, uint256 _value) public returns (bool success) {\n        allowed[msg.sender][_spender] = _value;\n        Approval(msg.sender, _spender, _value);\n        return true;\n    }\n\n    function allowance(address _owner, address _spender) public view returns (uint256 remaining) {\n        return allowed[_owner][_spender];\n    }   \n}\n",
  "sourcePath": "/Users/kamescg/Documents/Projects/uPort/code/projects/hackathon-minimal/contracts/eip20/EIP20.sol",
  "ast": {
    "absolutePath": "/Users/kamescg/Documents/Projects/uPort/code/projects/hackathon-minimal/contracts/eip20/EIP20.sol",
    "exportedSymbols": {
      "EIP20": [
        284
      ]
    },
    "id": 285,
    "nodeType": "SourceUnit",
    "nodes": [
      {
        "id": 58,
        "literals": [
          "solidity",
          "^",
          "0.4",
          ".18"
        ],
        "nodeType": "PragmaDirective",
        "src": "102:24:1"
      },
      {
        "absolutePath": "/Users/kamescg/Documents/Projects/uPort/code/projects/hackathon-minimal/contracts/eip20/EIP20Interface.sol",
        "file": "./EIP20Interface.sol",
        "id": 59,
        "nodeType": "ImportDirective",
        "scope": 285,
        "sourceUnit": 498,
        "src": "128:30:1",
        "symbolAliases": [],
        "unitAlias": ""
      },
      {
        "baseContracts": [
          {
            "arguments": [],
            "baseName": {
              "contractScope": null,
              "id": 60,
              "name": "EIP20Interface",
              "nodeType": "UserDefinedTypeName",
              "referencedDeclaration": 497,
              "src": "179:14:1",
              "typeDescriptions": {
                "typeIdentifier": "t_contract$_EIP20Interface_$497",
                "typeString": "contract EIP20Interface"
              }
            },
            "id": 61,
            "nodeType": "InheritanceSpecifier",
            "src": "179:14:1"
          }
        ],
        "contractDependencies": [
          497
        ],
        "contractKind": "contract",
        "documentation": null,
        "fullyImplemented": true,
        "id": 284,
        "linearizedBaseContracts": [
          284,
          497
        ],
        "name": "EIP20",
        "nodeType": "ContractDefinition",
        "nodes": [
          {
            "constant": true,
            "id": 68,
            "name": "MAX_UINT256",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "201:49:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_uint256",
              "typeString": "uint256"
            },
            "typeName": {
              "id": 62,
              "name": "uint256",
              "nodeType": "ElementaryTypeName",
              "src": "201:7:1",
              "typeDescriptions": {
                "typeIdentifier": "t_uint256",
                "typeString": "uint256"
              }
            },
            "value": {
              "argumentTypes": null,
              "commonType": {
                "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639935_by_1",
                "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639935"
              },
              "id": 67,
              "isConstant": false,
              "isLValue": false,
              "isPure": true,
              "lValueRequested": false,
              "leftExpression": {
                "argumentTypes": null,
                "commonType": {
                  "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639936_by_1",
                  "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639936"
                },
                "id": 65,
                "isConstant": false,
                "isLValue": false,
                "isPure": true,
                "lValueRequested": false,
                "leftExpression": {
                  "argumentTypes": null,
                  "hexValue": "32",
                  "id": 63,
                  "isConstant": false,
                  "isLValue": false,
                  "isPure": true,
                  "kind": "number",
                  "lValueRequested": false,
                  "nodeType": "Literal",
                  "src": "240:1:1",
                  "subdenomination": null,
                  "typeDescriptions": {
                    "typeIdentifier": "t_rational_2_by_1",
                    "typeString": "int_const 2"
                  },
                  "value": "2"
                },
                "nodeType": "BinaryOperation",
                "operator": "**",
                "rightExpression": {
                  "argumentTypes": null,
                  "hexValue": "323536",
                  "id": 64,
                  "isConstant": false,
                  "isLValue": false,
                  "isPure": true,
                  "kind": "number",
                  "lValueRequested": false,
                  "nodeType": "Literal",
                  "src": "243:3:1",
                  "subdenomination": null,
                  "typeDescriptions": {
                    "typeIdentifier": "t_rational_256_by_1",
                    "typeString": "int_const 256"
                  },
                  "value": "256"
                },
                "src": "240:6:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639936_by_1",
                  "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639936"
                }
              },
              "nodeType": "BinaryOperation",
              "operator": "-",
              "rightExpression": {
                "argumentTypes": null,
                "hexValue": "31",
                "id": 66,
                "isConstant": false,
                "isLValue": false,
                "isPure": true,
                "kind": "number",
                "lValueRequested": false,
                "nodeType": "Literal",
                "src": "249:1:1",
                "subdenomination": null,
                "typeDescriptions": {
                  "typeIdentifier": "t_rational_1_by_1",
                  "typeString": "int_const 1"
                },
                "value": "1"
              },
              "src": "240:10:1",
              "typeDescriptions": {
                "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639935_by_1",
                "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639935"
              }
            },
            "visibility": "private"
          },
          {
            "constant": false,
            "id": 72,
            "name": "balances",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "256:44:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
              "typeString": "mapping(address => uint256)"
            },
            "typeName": {
              "id": 71,
              "keyType": {
                "id": 69,
                "name": "address",
                "nodeType": "ElementaryTypeName",
                "src": "265:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_address",
                  "typeString": "address"
                }
              },
              "nodeType": "Mapping",
              "src": "256:28:1",
              "typeDescriptions": {
                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                "typeString": "mapping(address => uint256)"
              },
              "valueType": {
                "id": 70,
                "name": "uint256",
                "nodeType": "ElementaryTypeName",
                "src": "276:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_uint256",
                  "typeString": "uint256"
                }
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 78,
            "name": "allowed",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "306:64:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
              "typeString": "mapping(address => mapping(address => uint256))"
            },
            "typeName": {
              "id": 77,
              "keyType": {
                "id": 73,
                "name": "address",
                "nodeType": "ElementaryTypeName",
                "src": "315:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_address",
                  "typeString": "address"
                }
              },
              "nodeType": "Mapping",
              "src": "306:49:1",
              "typeDescriptions": {
                "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                "typeString": "mapping(address => mapping(address => uint256))"
              },
              "valueType": {
                "id": 76,
                "keyType": {
                  "id": 74,
                  "name": "address",
                  "nodeType": "ElementaryTypeName",
                  "src": "335:7:1",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  }
                },
                "nodeType": "Mapping",
                "src": "326:28:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                  "typeString": "mapping(address => uint256)"
                },
                "valueType": {
                  "id": 75,
                  "name": "uint256",
                  "nodeType": "ElementaryTypeName",
                  "src": "346:7:1",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  }
                }
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 80,
            "name": "name",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "663:18:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_string_storage",
              "typeString": "string storage ref"
            },
            "typeName": {
              "id": 79,
              "name": "string",
              "nodeType": "ElementaryTypeName",
              "src": "663:6:1",
              "typeDescriptions": {
                "typeIdentifier": "t_string_storage_ptr",
                "typeString": "string storage pointer"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 82,
            "name": "decimals",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "734:21:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_uint8",
              "typeString": "uint8"
            },
            "typeName": {
              "id": 81,
              "name": "uint8",
              "nodeType": "ElementaryTypeName",
              "src": "734:5:1",
              "typeDescriptions": {
                "typeIdentifier": "t_uint8",
                "typeString": "uint8"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 84,
            "name": "symbol",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "805:20:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_string_storage",
              "typeString": "string storage ref"
            },
            "typeName": {
              "id": 83,
              "name": "string",
              "nodeType": "ElementaryTypeName",
              "src": "805:6:1",
              "typeDescriptions": {
                "typeIdentifier": "t_string_storage_ptr",
                "typeString": "string storage pointer"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "body": {
              "id": 118,
              "nodeType": "Block",
              "src": "1017:493:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 100,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 95,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1027:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 98,
                      "indexExpression": {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 96,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1036:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 97,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1036:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1027:20:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 99,
                      "name": "_initialAmount",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 86,
                      "src": "1050:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1027:37:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 101,
                  "nodeType": "ExpressionStatement",
                  "src": "1027:37:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 104,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 102,
                      "name": "totalSupply",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 435,
                      "src": "1127:11:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 103,
                      "name": "_initialAmount",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 86,
                      "src": "1141:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1127:28:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 105,
                  "nodeType": "ExpressionStatement",
                  "src": "1127:28:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 108,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 106,
                      "name": "name",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 80,
                      "src": "1211:4:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_storage",
                        "typeString": "string storage ref"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 107,
                      "name": "_tokenName",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 88,
                      "src": "1218:10:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_memory_ptr",
                        "typeString": "string memory"
                      }
                    },
                    "src": "1211:17:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage",
                      "typeString": "string storage ref"
                    }
                  },
                  "id": 109,
                  "nodeType": "ExpressionStatement",
                  "src": "1211:17:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 112,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 110,
                      "name": "decimals",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 82,
                      "src": "1309:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint8",
                        "typeString": "uint8"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 111,
                      "name": "_decimalUnits",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 90,
                      "src": "1320:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint8",
                        "typeString": "uint8"
                      }
                    },
                    "src": "1309:24:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint8",
                      "typeString": "uint8"
                    }
                  },
                  "id": 113,
                  "nodeType": "ExpressionStatement",
                  "src": "1309:24:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 116,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 114,
                      "name": "symbol",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 84,
                      "src": "1413:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_storage",
                        "typeString": "string storage ref"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 115,
                      "name": "_tokenSymbol",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 92,
                      "src": "1422:12:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_memory_ptr",
                        "typeString": "string memory"
                      }
                    },
                    "src": "1413:21:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage",
                      "typeString": "string storage ref"
                    }
                  },
                  "id": 117,
                  "nodeType": "ExpressionStatement",
                  "src": "1413:21:1"
                }
              ]
            },
            "id": 119,
            "implemented": true,
            "isConstructor": true,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "EIP20",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 93,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 86,
                  "name": "_initialAmount",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "896:22:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 85,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "896:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 88,
                  "name": "_tokenName",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "928:17:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_string_memory_ptr",
                    "typeString": "string memory"
                  },
                  "typeName": {
                    "id": 87,
                    "name": "string",
                    "nodeType": "ElementaryTypeName",
                    "src": "928:6:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage_ptr",
                      "typeString": "string storage pointer"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 90,
                  "name": "_decimalUnits",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "955:19:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint8",
                    "typeString": "uint8"
                  },
                  "typeName": {
                    "id": 89,
                    "name": "uint8",
                    "nodeType": "ElementaryTypeName",
                    "src": "955:5:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint8",
                      "typeString": "uint8"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 92,
                  "name": "_tokenSymbol",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "984:19:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_string_memory_ptr",
                    "typeString": "string memory"
                  },
                  "typeName": {
                    "id": 91,
                    "name": "string",
                    "nodeType": "ElementaryTypeName",
                    "src": "984:6:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage_ptr",
                      "typeString": "string storage pointer"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "886:123:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 94,
              "nodeType": "ParameterList",
              "parameters": [],
              "src": "1017:0:1"
            },
            "scope": 284,
            "src": "872:638:1",
            "stateMutability": "nonpayable",
            "superFunction": null,
            "visibility": "public"
          },
          {
            "body": {
              "id": 159,
              "nodeType": "Block",
              "src": "1593:193:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "commonType": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        },
                        "id": 134,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "leftExpression": {
                          "argumentTypes": null,
                          "baseExpression": {
                            "argumentTypes": null,
                            "id": 129,
                            "name": "balances",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 72,
                            "src": "1611:8:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                              "typeString": "mapping(address => uint256)"
                            }
                          },
                          "id": 132,
                          "indexExpression": {
                            "argumentTypes": null,
                            "expression": {
                              "argumentTypes": null,
                              "id": 130,
                              "name": "msg",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 509,
                              "src": "1620:3:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_magic_message",
                                "typeString": "msg"
                              }
                            },
                            "id": 131,
                            "isConstant": false,
                            "isLValue": false,
                            "isPure": false,
                            "lValueRequested": false,
                            "memberName": "sender",
                            "nodeType": "MemberAccess",
                            "referencedDeclaration": null,
                            "src": "1620:10:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_address",
                              "typeString": "address"
                            }
                          },
                          "isConstant": false,
                          "isLValue": true,
                          "isPure": false,
                          "lValueRequested": false,
                          "nodeType": "IndexAccess",
                          "src": "1611:20:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "nodeType": "BinaryOperation",
                        "operator": ">=",
                        "rightExpression": {
                          "argumentTypes": null,
                          "id": 133,
                          "name": "_value",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 123,
                          "src": "1635:6:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "src": "1611:30:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      ],
                      "id": 128,
                      "name": "require",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 512,
                      "src": "1603:7:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_require_pure$_t_bool_$returns$__$",
                        "typeString": "function (bool) pure"
                      }
                    },
                    "id": 135,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1603:39:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 136,
                  "nodeType": "ExpressionStatement",
                  "src": "1603:39:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 142,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 137,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1652:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 140,
                      "indexExpression": {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 138,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1661:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 139,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1661:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1652:20:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "-=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 141,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 123,
                      "src": "1676:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1652:30:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 143,
                  "nodeType": "ExpressionStatement",
                  "src": "1652:30:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 148,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 144,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1692:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 146,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 145,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 121,
                        "src": "1701:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1692:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "+=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 147,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 123,
                      "src": "1709:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1692:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 149,
                  "nodeType": "ExpressionStatement",
                  "src": "1692:23:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 151,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1734:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 152,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1734:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 153,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 121,
                        "src": "1746:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 154,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 123,
                        "src": "1751:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 150,
                      "name": "Transfer",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 488,
                      "src": "1725:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 155,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1725:33:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 156,
                  "nodeType": "ExpressionStatement",
                  "src": "1725:33:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 157,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "1775:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 127,
                  "id": 158,
                  "nodeType": "Return",
                  "src": "1768:11:1"
                }
              ]
            },
            "id": 160,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "transfer",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 124,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 121,
                  "name": "_to",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1534:11:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 120,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1534:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 123,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1547:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 122,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "1547:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1533:29:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 127,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 126,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1579:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 125,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "1579:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1578:14:1"
            },
            "scope": 284,
            "src": "1516:270:1",
            "stateMutability": "nonpayable",
            "superFunction": 451,
            "visibility": "public"
          },
          {
            "body": {
              "id": 226,
              "nodeType": "Block",
              "src": "1888:356:1",
              "statements": [
                {
                  "assignments": [
                    172
                  ],
                  "declarations": [
                    {
                      "constant": false,
                      "id": 172,
                      "name": "allowance",
                      "nodeType": "VariableDeclaration",
                      "scope": 227,
                      "src": "1898:17:1",
                      "stateVariable": false,
                      "storageLocation": "default",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      },
                      "typeName": {
                        "id": 171,
                        "name": "uint256",
                        "nodeType": "ElementaryTypeName",
                        "src": "1898:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      },
                      "value": null,
                      "visibility": "internal"
                    }
                  ],
                  "id": 179,
                  "initialValue": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 173,
                        "name": "allowed",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 78,
                        "src": "1918:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                          "typeString": "mapping(address => mapping(address => uint256))"
                        }
                      },
                      "id": 175,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 174,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "1926:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": false,
                      "nodeType": "IndexAccess",
                      "src": "1918:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 178,
                    "indexExpression": {
                      "argumentTypes": null,
                      "expression": {
                        "argumentTypes": null,
                        "id": 176,
                        "name": "msg",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 509,
                        "src": "1933:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_magic_message",
                          "typeString": "msg"
                        }
                      },
                      "id": 177,
                      "isConstant": false,
                      "isLValue": false,
                      "isPure": false,
                      "lValueRequested": false,
                      "memberName": "sender",
                      "nodeType": "MemberAccess",
                      "referencedDeclaration": null,
                      "src": "1933:10:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "1918:26:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "nodeType": "VariableDeclarationStatement",
                  "src": "1898:46:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "commonType": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        },
                        "id": 189,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "leftExpression": {
                          "argumentTypes": null,
                          "commonType": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          },
                          "id": 185,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftExpression": {
                            "argumentTypes": null,
                            "baseExpression": {
                              "argumentTypes": null,
                              "id": 181,
                              "name": "balances",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 72,
                              "src": "1962:8:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                                "typeString": "mapping(address => uint256)"
                              }
                            },
                            "id": 183,
                            "indexExpression": {
                              "argumentTypes": null,
                              "id": 182,
                              "name": "_from",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 162,
                              "src": "1971:5:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_address",
                                "typeString": "address"
                              }
                            },
                            "isConstant": false,
                            "isLValue": true,
                            "isPure": false,
                            "lValueRequested": false,
                            "nodeType": "IndexAccess",
                            "src": "1962:15:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "BinaryOperation",
                          "operator": ">=",
                          "rightExpression": {
                            "argumentTypes": null,
                            "id": 184,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "1981:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "1962:25:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_bool",
                            "typeString": "bool"
                          }
                        },
                        "nodeType": "BinaryOperation",
                        "operator": "&&",
                        "rightExpression": {
                          "argumentTypes": null,
                          "commonType": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          },
                          "id": 188,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftExpression": {
                            "argumentTypes": null,
                            "id": 186,
                            "name": "allowance",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 172,
                            "src": "1991:9:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "BinaryOperation",
                          "operator": ">=",
                          "rightExpression": {
                            "argumentTypes": null,
                            "id": 187,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "2004:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "1991:19:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_bool",
                            "typeString": "bool"
                          }
                        },
                        "src": "1962:48:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      ],
                      "id": 180,
                      "name": "require",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 512,
                      "src": "1954:7:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_require_pure$_t_bool_$returns$__$",
                        "typeString": "function (bool) pure"
                      }
                    },
                    "id": 190,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1954:57:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 191,
                  "nodeType": "ExpressionStatement",
                  "src": "1954:57:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 196,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 192,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "2021:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 194,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 193,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 164,
                        "src": "2030:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2021:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "+=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 195,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 166,
                      "src": "2038:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2021:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 197,
                  "nodeType": "ExpressionStatement",
                  "src": "2021:23:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 202,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 198,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "2054:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 200,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 199,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "2063:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2054:15:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "-=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 201,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 166,
                      "src": "2073:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2054:25:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 203,
                  "nodeType": "ExpressionStatement",
                  "src": "2054:25:1"
                },
                {
                  "condition": {
                    "argumentTypes": null,
                    "commonType": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    },
                    "id": 206,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftExpression": {
                      "argumentTypes": null,
                      "id": 204,
                      "name": "allowance",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 172,
                      "src": "2093:9:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "BinaryOperation",
                    "operator": "<",
                    "rightExpression": {
                      "argumentTypes": null,
                      "id": 205,
                      "name": "MAX_UINT256",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 68,
                      "src": "2105:11:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2093:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "falseBody": null,
                  "id": 217,
                  "nodeType": "IfStatement",
                  "src": "2089:90:1",
                  "trueBody": {
                    "id": 216,
                    "nodeType": "Block",
                    "src": "2118:61:1",
                    "statements": [
                      {
                        "expression": {
                          "argumentTypes": null,
                          "id": 214,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftHandSide": {
                            "argumentTypes": null,
                            "baseExpression": {
                              "argumentTypes": null,
                              "baseExpression": {
                                "argumentTypes": null,
                                "id": 207,
                                "name": "allowed",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 78,
                                "src": "2132:7:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                                  "typeString": "mapping(address => mapping(address => uint256))"
                                }
                              },
                              "id": 211,
                              "indexExpression": {
                                "argumentTypes": null,
                                "id": 208,
                                "name": "_from",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 162,
                                "src": "2140:5:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_address",
                                  "typeString": "address"
                                }
                              },
                              "isConstant": false,
                              "isLValue": true,
                              "isPure": false,
                              "lValueRequested": false,
                              "nodeType": "IndexAccess",
                              "src": "2132:14:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                                "typeString": "mapping(address => uint256)"
                              }
                            },
                            "id": 212,
                            "indexExpression": {
                              "argumentTypes": null,
                              "expression": {
                                "argumentTypes": null,
                                "id": 209,
                                "name": "msg",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 509,
                                "src": "2147:3:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_magic_message",
                                  "typeString": "msg"
                                }
                              },
                              "id": 210,
                              "isConstant": false,
                              "isLValue": false,
                              "isPure": false,
                              "lValueRequested": false,
                              "memberName": "sender",
                              "nodeType": "MemberAccess",
                              "referencedDeclaration": null,
                              "src": "2147:10:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_address",
                                "typeString": "address"
                              }
                            },
                            "isConstant": false,
                            "isLValue": true,
                            "isPure": false,
                            "lValueRequested": true,
                            "nodeType": "IndexAccess",
                            "src": "2132:26:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "Assignment",
                          "operator": "-=",
                          "rightHandSide": {
                            "argumentTypes": null,
                            "id": 213,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "2162:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "2132:36:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "id": 215,
                        "nodeType": "ExpressionStatement",
                        "src": "2132:36:1"
                      }
                    ]
                  }
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "id": 219,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "2197:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 220,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 164,
                        "src": "2204:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 221,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 166,
                        "src": "2209:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 218,
                      "name": "Transfer",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 488,
                      "src": "2188:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 222,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "2188:28:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 223,
                  "nodeType": "ExpressionStatement",
                  "src": "2188:28:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 224,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "2233:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 170,
                  "id": 225,
                  "nodeType": "Return",
                  "src": "2226:11:1"
                }
              ]
            },
            "id": 227,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "transferFrom",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 167,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 162,
                  "name": "_from",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1814:13:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 161,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1814:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 164,
                  "name": "_to",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1829:11:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 163,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1829:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 166,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1842:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 165,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "1842:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1813:44:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 170,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 169,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1874:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 168,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "1874:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1873:14:1"
            },
            "scope": 284,
            "src": "1792:452:1",
            "stateMutability": "nonpayable",
            "superFunction": 462,
            "visibility": "public"
          },
          {
            "body": {
              "id": 238,
              "nodeType": "Block",
              "src": "2323:40:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "id": 234,
                      "name": "balances",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 72,
                      "src": "2340:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 236,
                    "indexExpression": {
                      "argumentTypes": null,
                      "id": 235,
                      "name": "_owner",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 229,
                      "src": "2349:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "2340:16:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "functionReturnParameters": 233,
                  "id": 237,
                  "nodeType": "Return",
                  "src": "2333:23:1"
                }
              ]
            },
            "id": 239,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": true,
            "modifiers": [],
            "name": "balanceOf",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 230,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 229,
                  "name": "_owner",
                  "nodeType": "VariableDeclaration",
                  "scope": 239,
                  "src": "2269:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 228,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2269:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2268:16:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 233,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 232,
                  "name": "balance",
                  "nodeType": "VariableDeclaration",
                  "scope": 239,
                  "src": "2306:15:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 231,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2306:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2305:17:1"
            },
            "scope": 284,
            "src": "2250:113:1",
            "stateMutability": "view",
            "superFunction": 442,
            "visibility": "public"
          },
          {
            "body": {
              "id": 266,
              "nodeType": "Block",
              "src": "2450:124:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 255,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "baseExpression": {
                          "argumentTypes": null,
                          "id": 248,
                          "name": "allowed",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 78,
                          "src": "2460:7:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                            "typeString": "mapping(address => mapping(address => uint256))"
                          }
                        },
                        "id": 252,
                        "indexExpression": {
                          "argumentTypes": null,
                          "expression": {
                            "argumentTypes": null,
                            "id": 249,
                            "name": "msg",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 509,
                            "src": "2468:3:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_magic_message",
                              "typeString": "msg"
                            }
                          },
                          "id": 250,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "memberName": "sender",
                          "nodeType": "MemberAccess",
                          "referencedDeclaration": null,
                          "src": "2468:10:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_address",
                            "typeString": "address"
                          }
                        },
                        "isConstant": false,
                        "isLValue": true,
                        "isPure": false,
                        "lValueRequested": false,
                        "nodeType": "IndexAccess",
                        "src": "2460:19:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 253,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 251,
                        "name": "_spender",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 241,
                        "src": "2480:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2460:29:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 254,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 243,
                      "src": "2492:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2460:38:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 256,
                  "nodeType": "ExpressionStatement",
                  "src": "2460:38:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 258,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "2517:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 259,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "2517:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 260,
                        "name": "_spender",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 241,
                        "src": "2529:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 261,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 243,
                        "src": "2539:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 257,
                      "name": "Approval",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 496,
                      "src": "2508:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 262,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "2508:38:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 263,
                  "nodeType": "ExpressionStatement",
                  "src": "2508:38:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 264,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "2563:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 247,
                  "id": 265,
                  "nodeType": "Return",
                  "src": "2556:11:1"
                }
              ]
            },
            "id": 267,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "approve",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 244,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 241,
                  "name": "_spender",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2386:16:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 240,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2386:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 243,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2404:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 242,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2404:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2385:34:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 247,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 246,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2436:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 245,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "2436:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2435:14:1"
            },
            "scope": 284,
            "src": "2369:205:1",
            "stateMutability": "nonpayable",
            "superFunction": 471,
            "visibility": "public"
          },
          {
            "body": {
              "id": 282,
              "nodeType": "Block",
              "src": "2673:49:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 276,
                        "name": "allowed",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 78,
                        "src": "2690:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                          "typeString": "mapping(address => mapping(address => uint256))"
                        }
                      },
                      "id": 278,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 277,
                        "name": "_owner",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 269,
                        "src": "2698:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": false,
                      "nodeType": "IndexAccess",
                      "src": "2690:15:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 280,
                    "indexExpression": {
                      "argumentTypes": null,
                      "id": 279,
                      "name": "_spender",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 271,
                      "src": "2706:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "2690:25:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "functionReturnParameters": 275,
                  "id": 281,
                  "nodeType": "Return",
                  "src": "2683:32:1"
                }
              ]
            },
            "id": 283,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": true,
            "modifiers": [],
            "name": "allowance",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 272,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 269,
                  "name": "_owner",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2599:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 268,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2599:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 271,
                  "name": "_spender",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2615:16:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 270,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2615:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2598:34:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 275,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 274,
                  "name": "remaining",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2654:17:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 273,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2654:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2653:19:1"
            },
            "scope": 284,
            "src": "2580:142:1",
            "stateMutability": "view",
            "superFunction": 480,
            "visibility": "public"
          }
        ],
        "scope": 285,
        "src": "161:2566:1"
      }
    ],
    "src": "102:2626:1"
  },
  "legacyAST": {
    "absolutePath": "/Users/kamescg/Documents/Projects/uPort/code/projects/hackathon-minimal/contracts/eip20/EIP20.sol",
    "exportedSymbols": {
      "EIP20": [
        284
      ]
    },
    "id": 285,
    "nodeType": "SourceUnit",
    "nodes": [
      {
        "id": 58,
        "literals": [
          "solidity",
          "^",
          "0.4",
          ".18"
        ],
        "nodeType": "PragmaDirective",
        "src": "102:24:1"
      },
      {
        "absolutePath": "/Users/kamescg/Documents/Projects/uPort/code/projects/hackathon-minimal/contracts/eip20/EIP20Interface.sol",
        "file": "./EIP20Interface.sol",
        "id": 59,
        "nodeType": "ImportDirective",
        "scope": 285,
        "sourceUnit": 498,
        "src": "128:30:1",
        "symbolAliases": [],
        "unitAlias": ""
      },
      {
        "baseContracts": [
          {
            "arguments": [],
            "baseName": {
              "contractScope": null,
              "id": 60,
              "name": "EIP20Interface",
              "nodeType": "UserDefinedTypeName",
              "referencedDeclaration": 497,
              "src": "179:14:1",
              "typeDescriptions": {
                "typeIdentifier": "t_contract$_EIP20Interface_$497",
                "typeString": "contract EIP20Interface"
              }
            },
            "id": 61,
            "nodeType": "InheritanceSpecifier",
            "src": "179:14:1"
          }
        ],
        "contractDependencies": [
          497
        ],
        "contractKind": "contract",
        "documentation": null,
        "fullyImplemented": true,
        "id": 284,
        "linearizedBaseContracts": [
          284,
          497
        ],
        "name": "EIP20",
        "nodeType": "ContractDefinition",
        "nodes": [
          {
            "constant": true,
            "id": 68,
            "name": "MAX_UINT256",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "201:49:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_uint256",
              "typeString": "uint256"
            },
            "typeName": {
              "id": 62,
              "name": "uint256",
              "nodeType": "ElementaryTypeName",
              "src": "201:7:1",
              "typeDescriptions": {
                "typeIdentifier": "t_uint256",
                "typeString": "uint256"
              }
            },
            "value": {
              "argumentTypes": null,
              "commonType": {
                "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639935_by_1",
                "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639935"
              },
              "id": 67,
              "isConstant": false,
              "isLValue": false,
              "isPure": true,
              "lValueRequested": false,
              "leftExpression": {
                "argumentTypes": null,
                "commonType": {
                  "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639936_by_1",
                  "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639936"
                },
                "id": 65,
                "isConstant": false,
                "isLValue": false,
                "isPure": true,
                "lValueRequested": false,
                "leftExpression": {
                  "argumentTypes": null,
                  "hexValue": "32",
                  "id": 63,
                  "isConstant": false,
                  "isLValue": false,
                  "isPure": true,
                  "kind": "number",
                  "lValueRequested": false,
                  "nodeType": "Literal",
                  "src": "240:1:1",
                  "subdenomination": null,
                  "typeDescriptions": {
                    "typeIdentifier": "t_rational_2_by_1",
                    "typeString": "int_const 2"
                  },
                  "value": "2"
                },
                "nodeType": "BinaryOperation",
                "operator": "**",
                "rightExpression": {
                  "argumentTypes": null,
                  "hexValue": "323536",
                  "id": 64,
                  "isConstant": false,
                  "isLValue": false,
                  "isPure": true,
                  "kind": "number",
                  "lValueRequested": false,
                  "nodeType": "Literal",
                  "src": "243:3:1",
                  "subdenomination": null,
                  "typeDescriptions": {
                    "typeIdentifier": "t_rational_256_by_1",
                    "typeString": "int_const 256"
                  },
                  "value": "256"
                },
                "src": "240:6:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639936_by_1",
                  "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639936"
                }
              },
              "nodeType": "BinaryOperation",
              "operator": "-",
              "rightExpression": {
                "argumentTypes": null,
                "hexValue": "31",
                "id": 66,
                "isConstant": false,
                "isLValue": false,
                "isPure": true,
                "kind": "number",
                "lValueRequested": false,
                "nodeType": "Literal",
                "src": "249:1:1",
                "subdenomination": null,
                "typeDescriptions": {
                  "typeIdentifier": "t_rational_1_by_1",
                  "typeString": "int_const 1"
                },
                "value": "1"
              },
              "src": "240:10:1",
              "typeDescriptions": {
                "typeIdentifier": "t_rational_115792089237316195423570985008687907853269984665640564039457584007913129639935_by_1",
                "typeString": "int_const 115792089237316195423570985008687907853269984665640564039457584007913129639935"
              }
            },
            "visibility": "private"
          },
          {
            "constant": false,
            "id": 72,
            "name": "balances",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "256:44:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
              "typeString": "mapping(address => uint256)"
            },
            "typeName": {
              "id": 71,
              "keyType": {
                "id": 69,
                "name": "address",
                "nodeType": "ElementaryTypeName",
                "src": "265:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_address",
                  "typeString": "address"
                }
              },
              "nodeType": "Mapping",
              "src": "256:28:1",
              "typeDescriptions": {
                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                "typeString": "mapping(address => uint256)"
              },
              "valueType": {
                "id": 70,
                "name": "uint256",
                "nodeType": "ElementaryTypeName",
                "src": "276:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_uint256",
                  "typeString": "uint256"
                }
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 78,
            "name": "allowed",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "306:64:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
              "typeString": "mapping(address => mapping(address => uint256))"
            },
            "typeName": {
              "id": 77,
              "keyType": {
                "id": 73,
                "name": "address",
                "nodeType": "ElementaryTypeName",
                "src": "315:7:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_address",
                  "typeString": "address"
                }
              },
              "nodeType": "Mapping",
              "src": "306:49:1",
              "typeDescriptions": {
                "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                "typeString": "mapping(address => mapping(address => uint256))"
              },
              "valueType": {
                "id": 76,
                "keyType": {
                  "id": 74,
                  "name": "address",
                  "nodeType": "ElementaryTypeName",
                  "src": "335:7:1",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  }
                },
                "nodeType": "Mapping",
                "src": "326:28:1",
                "typeDescriptions": {
                  "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                  "typeString": "mapping(address => uint256)"
                },
                "valueType": {
                  "id": 75,
                  "name": "uint256",
                  "nodeType": "ElementaryTypeName",
                  "src": "346:7:1",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  }
                }
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 80,
            "name": "name",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "663:18:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_string_storage",
              "typeString": "string storage ref"
            },
            "typeName": {
              "id": 79,
              "name": "string",
              "nodeType": "ElementaryTypeName",
              "src": "663:6:1",
              "typeDescriptions": {
                "typeIdentifier": "t_string_storage_ptr",
                "typeString": "string storage pointer"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 82,
            "name": "decimals",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "734:21:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_uint8",
              "typeString": "uint8"
            },
            "typeName": {
              "id": 81,
              "name": "uint8",
              "nodeType": "ElementaryTypeName",
              "src": "734:5:1",
              "typeDescriptions": {
                "typeIdentifier": "t_uint8",
                "typeString": "uint8"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "constant": false,
            "id": 84,
            "name": "symbol",
            "nodeType": "VariableDeclaration",
            "scope": 284,
            "src": "805:20:1",
            "stateVariable": true,
            "storageLocation": "default",
            "typeDescriptions": {
              "typeIdentifier": "t_string_storage",
              "typeString": "string storage ref"
            },
            "typeName": {
              "id": 83,
              "name": "string",
              "nodeType": "ElementaryTypeName",
              "src": "805:6:1",
              "typeDescriptions": {
                "typeIdentifier": "t_string_storage_ptr",
                "typeString": "string storage pointer"
              }
            },
            "value": null,
            "visibility": "public"
          },
          {
            "body": {
              "id": 118,
              "nodeType": "Block",
              "src": "1017:493:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 100,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 95,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1027:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 98,
                      "indexExpression": {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 96,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1036:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 97,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1036:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1027:20:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 99,
                      "name": "_initialAmount",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 86,
                      "src": "1050:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1027:37:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 101,
                  "nodeType": "ExpressionStatement",
                  "src": "1027:37:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 104,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 102,
                      "name": "totalSupply",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 435,
                      "src": "1127:11:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 103,
                      "name": "_initialAmount",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 86,
                      "src": "1141:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1127:28:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 105,
                  "nodeType": "ExpressionStatement",
                  "src": "1127:28:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 108,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 106,
                      "name": "name",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 80,
                      "src": "1211:4:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_storage",
                        "typeString": "string storage ref"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 107,
                      "name": "_tokenName",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 88,
                      "src": "1218:10:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_memory_ptr",
                        "typeString": "string memory"
                      }
                    },
                    "src": "1211:17:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage",
                      "typeString": "string storage ref"
                    }
                  },
                  "id": 109,
                  "nodeType": "ExpressionStatement",
                  "src": "1211:17:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 112,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 110,
                      "name": "decimals",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 82,
                      "src": "1309:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint8",
                        "typeString": "uint8"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 111,
                      "name": "_decimalUnits",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 90,
                      "src": "1320:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint8",
                        "typeString": "uint8"
                      }
                    },
                    "src": "1309:24:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint8",
                      "typeString": "uint8"
                    }
                  },
                  "id": 113,
                  "nodeType": "ExpressionStatement",
                  "src": "1309:24:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 116,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "id": 114,
                      "name": "symbol",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 84,
                      "src": "1413:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_storage",
                        "typeString": "string storage ref"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 115,
                      "name": "_tokenSymbol",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 92,
                      "src": "1422:12:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_string_memory_ptr",
                        "typeString": "string memory"
                      }
                    },
                    "src": "1413:21:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage",
                      "typeString": "string storage ref"
                    }
                  },
                  "id": 117,
                  "nodeType": "ExpressionStatement",
                  "src": "1413:21:1"
                }
              ]
            },
            "id": 119,
            "implemented": true,
            "isConstructor": true,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "EIP20",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 93,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 86,
                  "name": "_initialAmount",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "896:22:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 85,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "896:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 88,
                  "name": "_tokenName",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "928:17:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_string_memory_ptr",
                    "typeString": "string memory"
                  },
                  "typeName": {
                    "id": 87,
                    "name": "string",
                    "nodeType": "ElementaryTypeName",
                    "src": "928:6:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage_ptr",
                      "typeString": "string storage pointer"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 90,
                  "name": "_decimalUnits",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "955:19:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint8",
                    "typeString": "uint8"
                  },
                  "typeName": {
                    "id": 89,
                    "name": "uint8",
                    "nodeType": "ElementaryTypeName",
                    "src": "955:5:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint8",
                      "typeString": "uint8"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 92,
                  "name": "_tokenSymbol",
                  "nodeType": "VariableDeclaration",
                  "scope": 119,
                  "src": "984:19:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_string_memory_ptr",
                    "typeString": "string memory"
                  },
                  "typeName": {
                    "id": 91,
                    "name": "string",
                    "nodeType": "ElementaryTypeName",
                    "src": "984:6:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_string_storage_ptr",
                      "typeString": "string storage pointer"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "886:123:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 94,
              "nodeType": "ParameterList",
              "parameters": [],
              "src": "1017:0:1"
            },
            "scope": 284,
            "src": "872:638:1",
            "stateMutability": "nonpayable",
            "superFunction": null,
            "visibility": "public"
          },
          {
            "body": {
              "id": 159,
              "nodeType": "Block",
              "src": "1593:193:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "commonType": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        },
                        "id": 134,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "leftExpression": {
                          "argumentTypes": null,
                          "baseExpression": {
                            "argumentTypes": null,
                            "id": 129,
                            "name": "balances",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 72,
                            "src": "1611:8:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                              "typeString": "mapping(address => uint256)"
                            }
                          },
                          "id": 132,
                          "indexExpression": {
                            "argumentTypes": null,
                            "expression": {
                              "argumentTypes": null,
                              "id": 130,
                              "name": "msg",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 509,
                              "src": "1620:3:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_magic_message",
                                "typeString": "msg"
                              }
                            },
                            "id": 131,
                            "isConstant": false,
                            "isLValue": false,
                            "isPure": false,
                            "lValueRequested": false,
                            "memberName": "sender",
                            "nodeType": "MemberAccess",
                            "referencedDeclaration": null,
                            "src": "1620:10:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_address",
                              "typeString": "address"
                            }
                          },
                          "isConstant": false,
                          "isLValue": true,
                          "isPure": false,
                          "lValueRequested": false,
                          "nodeType": "IndexAccess",
                          "src": "1611:20:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "nodeType": "BinaryOperation",
                        "operator": ">=",
                        "rightExpression": {
                          "argumentTypes": null,
                          "id": 133,
                          "name": "_value",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 123,
                          "src": "1635:6:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "src": "1611:30:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      ],
                      "id": 128,
                      "name": "require",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 512,
                      "src": "1603:7:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_require_pure$_t_bool_$returns$__$",
                        "typeString": "function (bool) pure"
                      }
                    },
                    "id": 135,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1603:39:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 136,
                  "nodeType": "ExpressionStatement",
                  "src": "1603:39:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 142,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 137,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1652:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 140,
                      "indexExpression": {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 138,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1661:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 139,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1661:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1652:20:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "-=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 141,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 123,
                      "src": "1676:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1652:30:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 143,
                  "nodeType": "ExpressionStatement",
                  "src": "1652:30:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 148,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 144,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "1692:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 146,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 145,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 121,
                        "src": "1701:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "1692:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "+=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 147,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 123,
                      "src": "1709:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "1692:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 149,
                  "nodeType": "ExpressionStatement",
                  "src": "1692:23:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 151,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "1734:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 152,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "1734:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 153,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 121,
                        "src": "1746:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 154,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 123,
                        "src": "1751:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 150,
                      "name": "Transfer",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 488,
                      "src": "1725:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 155,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1725:33:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 156,
                  "nodeType": "ExpressionStatement",
                  "src": "1725:33:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 157,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "1775:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 127,
                  "id": 158,
                  "nodeType": "Return",
                  "src": "1768:11:1"
                }
              ]
            },
            "id": 160,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "transfer",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 124,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 121,
                  "name": "_to",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1534:11:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 120,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1534:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 123,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1547:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 122,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "1547:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1533:29:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 127,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 126,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 160,
                  "src": "1579:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 125,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "1579:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1578:14:1"
            },
            "scope": 284,
            "src": "1516:270:1",
            "stateMutability": "nonpayable",
            "superFunction": 451,
            "visibility": "public"
          },
          {
            "body": {
              "id": 226,
              "nodeType": "Block",
              "src": "1888:356:1",
              "statements": [
                {
                  "assignments": [
                    172
                  ],
                  "declarations": [
                    {
                      "constant": false,
                      "id": 172,
                      "name": "allowance",
                      "nodeType": "VariableDeclaration",
                      "scope": 227,
                      "src": "1898:17:1",
                      "stateVariable": false,
                      "storageLocation": "default",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      },
                      "typeName": {
                        "id": 171,
                        "name": "uint256",
                        "nodeType": "ElementaryTypeName",
                        "src": "1898:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      },
                      "value": null,
                      "visibility": "internal"
                    }
                  ],
                  "id": 179,
                  "initialValue": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 173,
                        "name": "allowed",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 78,
                        "src": "1918:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                          "typeString": "mapping(address => mapping(address => uint256))"
                        }
                      },
                      "id": 175,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 174,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "1926:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": false,
                      "nodeType": "IndexAccess",
                      "src": "1918:14:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 178,
                    "indexExpression": {
                      "argumentTypes": null,
                      "expression": {
                        "argumentTypes": null,
                        "id": 176,
                        "name": "msg",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 509,
                        "src": "1933:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_magic_message",
                          "typeString": "msg"
                        }
                      },
                      "id": 177,
                      "isConstant": false,
                      "isLValue": false,
                      "isPure": false,
                      "lValueRequested": false,
                      "memberName": "sender",
                      "nodeType": "MemberAccess",
                      "referencedDeclaration": null,
                      "src": "1933:10:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "1918:26:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "nodeType": "VariableDeclarationStatement",
                  "src": "1898:46:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "commonType": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        },
                        "id": 189,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "leftExpression": {
                          "argumentTypes": null,
                          "commonType": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          },
                          "id": 185,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftExpression": {
                            "argumentTypes": null,
                            "baseExpression": {
                              "argumentTypes": null,
                              "id": 181,
                              "name": "balances",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 72,
                              "src": "1962:8:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                                "typeString": "mapping(address => uint256)"
                              }
                            },
                            "id": 183,
                            "indexExpression": {
                              "argumentTypes": null,
                              "id": 182,
                              "name": "_from",
                              "nodeType": "Identifier",
                              "overloadedDeclarations": [],
                              "referencedDeclaration": 162,
                              "src": "1971:5:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_address",
                                "typeString": "address"
                              }
                            },
                            "isConstant": false,
                            "isLValue": true,
                            "isPure": false,
                            "lValueRequested": false,
                            "nodeType": "IndexAccess",
                            "src": "1962:15:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "BinaryOperation",
                          "operator": ">=",
                          "rightExpression": {
                            "argumentTypes": null,
                            "id": 184,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "1981:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "1962:25:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_bool",
                            "typeString": "bool"
                          }
                        },
                        "nodeType": "BinaryOperation",
                        "operator": "&&",
                        "rightExpression": {
                          "argumentTypes": null,
                          "commonType": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          },
                          "id": 188,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftExpression": {
                            "argumentTypes": null,
                            "id": 186,
                            "name": "allowance",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 172,
                            "src": "1991:9:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "BinaryOperation",
                          "operator": ">=",
                          "rightExpression": {
                            "argumentTypes": null,
                            "id": 187,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "2004:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "1991:19:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_bool",
                            "typeString": "bool"
                          }
                        },
                        "src": "1962:48:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_bool",
                          "typeString": "bool"
                        }
                      ],
                      "id": 180,
                      "name": "require",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 512,
                      "src": "1954:7:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_require_pure$_t_bool_$returns$__$",
                        "typeString": "function (bool) pure"
                      }
                    },
                    "id": 190,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "1954:57:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 191,
                  "nodeType": "ExpressionStatement",
                  "src": "1954:57:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 196,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 192,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "2021:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 194,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 193,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 164,
                        "src": "2030:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2021:13:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "+=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 195,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 166,
                      "src": "2038:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2021:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 197,
                  "nodeType": "ExpressionStatement",
                  "src": "2021:23:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 202,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 198,
                        "name": "balances",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 72,
                        "src": "2054:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 200,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 199,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "2063:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2054:15:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "-=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 201,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 166,
                      "src": "2073:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2054:25:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 203,
                  "nodeType": "ExpressionStatement",
                  "src": "2054:25:1"
                },
                {
                  "condition": {
                    "argumentTypes": null,
                    "commonType": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    },
                    "id": 206,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftExpression": {
                      "argumentTypes": null,
                      "id": 204,
                      "name": "allowance",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 172,
                      "src": "2093:9:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "BinaryOperation",
                    "operator": "<",
                    "rightExpression": {
                      "argumentTypes": null,
                      "id": 205,
                      "name": "MAX_UINT256",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 68,
                      "src": "2105:11:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2093:23:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "falseBody": null,
                  "id": 217,
                  "nodeType": "IfStatement",
                  "src": "2089:90:1",
                  "trueBody": {
                    "id": 216,
                    "nodeType": "Block",
                    "src": "2118:61:1",
                    "statements": [
                      {
                        "expression": {
                          "argumentTypes": null,
                          "id": 214,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "leftHandSide": {
                            "argumentTypes": null,
                            "baseExpression": {
                              "argumentTypes": null,
                              "baseExpression": {
                                "argumentTypes": null,
                                "id": 207,
                                "name": "allowed",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 78,
                                "src": "2132:7:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                                  "typeString": "mapping(address => mapping(address => uint256))"
                                }
                              },
                              "id": 211,
                              "indexExpression": {
                                "argumentTypes": null,
                                "id": 208,
                                "name": "_from",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 162,
                                "src": "2140:5:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_address",
                                  "typeString": "address"
                                }
                              },
                              "isConstant": false,
                              "isLValue": true,
                              "isPure": false,
                              "lValueRequested": false,
                              "nodeType": "IndexAccess",
                              "src": "2132:14:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                                "typeString": "mapping(address => uint256)"
                              }
                            },
                            "id": 212,
                            "indexExpression": {
                              "argumentTypes": null,
                              "expression": {
                                "argumentTypes": null,
                                "id": 209,
                                "name": "msg",
                                "nodeType": "Identifier",
                                "overloadedDeclarations": [],
                                "referencedDeclaration": 509,
                                "src": "2147:3:1",
                                "typeDescriptions": {
                                  "typeIdentifier": "t_magic_message",
                                  "typeString": "msg"
                                }
                              },
                              "id": 210,
                              "isConstant": false,
                              "isLValue": false,
                              "isPure": false,
                              "lValueRequested": false,
                              "memberName": "sender",
                              "nodeType": "MemberAccess",
                              "referencedDeclaration": null,
                              "src": "2147:10:1",
                              "typeDescriptions": {
                                "typeIdentifier": "t_address",
                                "typeString": "address"
                              }
                            },
                            "isConstant": false,
                            "isLValue": true,
                            "isPure": false,
                            "lValueRequested": true,
                            "nodeType": "IndexAccess",
                            "src": "2132:26:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "nodeType": "Assignment",
                          "operator": "-=",
                          "rightHandSide": {
                            "argumentTypes": null,
                            "id": 213,
                            "name": "_value",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 166,
                            "src": "2162:6:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_uint256",
                              "typeString": "uint256"
                            }
                          },
                          "src": "2132:36:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_uint256",
                            "typeString": "uint256"
                          }
                        },
                        "id": 215,
                        "nodeType": "ExpressionStatement",
                        "src": "2132:36:1"
                      }
                    ]
                  }
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "id": 219,
                        "name": "_from",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 162,
                        "src": "2197:5:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 220,
                        "name": "_to",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 164,
                        "src": "2204:3:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 221,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 166,
                        "src": "2209:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 218,
                      "name": "Transfer",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 488,
                      "src": "2188:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 222,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "2188:28:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 223,
                  "nodeType": "ExpressionStatement",
                  "src": "2188:28:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 224,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "2233:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 170,
                  "id": 225,
                  "nodeType": "Return",
                  "src": "2226:11:1"
                }
              ]
            },
            "id": 227,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "transferFrom",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 167,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 162,
                  "name": "_from",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1814:13:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 161,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1814:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 164,
                  "name": "_to",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1829:11:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 163,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "1829:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 166,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1842:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 165,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "1842:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1813:44:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 170,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 169,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 227,
                  "src": "1874:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 168,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "1874:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "1873:14:1"
            },
            "scope": 284,
            "src": "1792:452:1",
            "stateMutability": "nonpayable",
            "superFunction": 462,
            "visibility": "public"
          },
          {
            "body": {
              "id": 238,
              "nodeType": "Block",
              "src": "2323:40:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "id": 234,
                      "name": "balances",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 72,
                      "src": "2340:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 236,
                    "indexExpression": {
                      "argumentTypes": null,
                      "id": 235,
                      "name": "_owner",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 229,
                      "src": "2349:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "2340:16:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "functionReturnParameters": 233,
                  "id": 237,
                  "nodeType": "Return",
                  "src": "2333:23:1"
                }
              ]
            },
            "id": 239,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": true,
            "modifiers": [],
            "name": "balanceOf",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 230,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 229,
                  "name": "_owner",
                  "nodeType": "VariableDeclaration",
                  "scope": 239,
                  "src": "2269:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 228,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2269:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2268:16:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 233,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 232,
                  "name": "balance",
                  "nodeType": "VariableDeclaration",
                  "scope": 239,
                  "src": "2306:15:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 231,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2306:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2305:17:1"
            },
            "scope": 284,
            "src": "2250:113:1",
            "stateMutability": "view",
            "superFunction": 442,
            "visibility": "public"
          },
          {
            "body": {
              "id": 266,
              "nodeType": "Block",
              "src": "2450:124:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "id": 255,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "lValueRequested": false,
                    "leftHandSide": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "baseExpression": {
                          "argumentTypes": null,
                          "id": 248,
                          "name": "allowed",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 78,
                          "src": "2460:7:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                            "typeString": "mapping(address => mapping(address => uint256))"
                          }
                        },
                        "id": 252,
                        "indexExpression": {
                          "argumentTypes": null,
                          "expression": {
                            "argumentTypes": null,
                            "id": 249,
                            "name": "msg",
                            "nodeType": "Identifier",
                            "overloadedDeclarations": [],
                            "referencedDeclaration": 509,
                            "src": "2468:3:1",
                            "typeDescriptions": {
                              "typeIdentifier": "t_magic_message",
                              "typeString": "msg"
                            }
                          },
                          "id": 250,
                          "isConstant": false,
                          "isLValue": false,
                          "isPure": false,
                          "lValueRequested": false,
                          "memberName": "sender",
                          "nodeType": "MemberAccess",
                          "referencedDeclaration": null,
                          "src": "2468:10:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_address",
                            "typeString": "address"
                          }
                        },
                        "isConstant": false,
                        "isLValue": true,
                        "isPure": false,
                        "lValueRequested": false,
                        "nodeType": "IndexAccess",
                        "src": "2460:19:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                          "typeString": "mapping(address => uint256)"
                        }
                      },
                      "id": 253,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 251,
                        "name": "_spender",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 241,
                        "src": "2480:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": true,
                      "nodeType": "IndexAccess",
                      "src": "2460:29:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "nodeType": "Assignment",
                    "operator": "=",
                    "rightHandSide": {
                      "argumentTypes": null,
                      "id": 254,
                      "name": "_value",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 243,
                      "src": "2492:6:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_uint256",
                        "typeString": "uint256"
                      }
                    },
                    "src": "2460:38:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "id": 256,
                  "nodeType": "ExpressionStatement",
                  "src": "2460:38:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "arguments": [
                      {
                        "argumentTypes": null,
                        "expression": {
                          "argumentTypes": null,
                          "id": 258,
                          "name": "msg",
                          "nodeType": "Identifier",
                          "overloadedDeclarations": [],
                          "referencedDeclaration": 509,
                          "src": "2517:3:1",
                          "typeDescriptions": {
                            "typeIdentifier": "t_magic_message",
                            "typeString": "msg"
                          }
                        },
                        "id": 259,
                        "isConstant": false,
                        "isLValue": false,
                        "isPure": false,
                        "lValueRequested": false,
                        "memberName": "sender",
                        "nodeType": "MemberAccess",
                        "referencedDeclaration": null,
                        "src": "2517:10:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 260,
                        "name": "_spender",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 241,
                        "src": "2529:8:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      {
                        "argumentTypes": null,
                        "id": 261,
                        "name": "_value",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 243,
                        "src": "2539:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      }
                    ],
                    "expression": {
                      "argumentTypes": [
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        },
                        {
                          "typeIdentifier": "t_uint256",
                          "typeString": "uint256"
                        }
                      ],
                      "id": 257,
                      "name": "Approval",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 496,
                      "src": "2508:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_function_event_nonpayable$_t_address_$_t_address_$_t_uint256_$returns$__$",
                        "typeString": "function (address,address,uint256)"
                      }
                    },
                    "id": 262,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": false,
                    "kind": "functionCall",
                    "lValueRequested": false,
                    "names": [],
                    "nodeType": "FunctionCall",
                    "src": "2508:38:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_tuple$__$",
                      "typeString": "tuple()"
                    }
                  },
                  "id": 263,
                  "nodeType": "ExpressionStatement",
                  "src": "2508:38:1"
                },
                {
                  "expression": {
                    "argumentTypes": null,
                    "hexValue": "74727565",
                    "id": 264,
                    "isConstant": false,
                    "isLValue": false,
                    "isPure": true,
                    "kind": "bool",
                    "lValueRequested": false,
                    "nodeType": "Literal",
                    "src": "2563:4:1",
                    "subdenomination": null,
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    },
                    "value": "true"
                  },
                  "functionReturnParameters": 247,
                  "id": 265,
                  "nodeType": "Return",
                  "src": "2556:11:1"
                }
              ]
            },
            "id": 267,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": false,
            "modifiers": [],
            "name": "approve",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 244,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 241,
                  "name": "_spender",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2386:16:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 240,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2386:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 243,
                  "name": "_value",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2404:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 242,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2404:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2385:34:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 247,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 246,
                  "name": "success",
                  "nodeType": "VariableDeclaration",
                  "scope": 267,
                  "src": "2436:12:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_bool",
                    "typeString": "bool"
                  },
                  "typeName": {
                    "id": 245,
                    "name": "bool",
                    "nodeType": "ElementaryTypeName",
                    "src": "2436:4:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_bool",
                      "typeString": "bool"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2435:14:1"
            },
            "scope": 284,
            "src": "2369:205:1",
            "stateMutability": "nonpayable",
            "superFunction": 471,
            "visibility": "public"
          },
          {
            "body": {
              "id": 282,
              "nodeType": "Block",
              "src": "2673:49:1",
              "statements": [
                {
                  "expression": {
                    "argumentTypes": null,
                    "baseExpression": {
                      "argumentTypes": null,
                      "baseExpression": {
                        "argumentTypes": null,
                        "id": 276,
                        "name": "allowed",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 78,
                        "src": "2690:7:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_mapping$_t_address_$_t_mapping$_t_address_$_t_uint256_$_$",
                          "typeString": "mapping(address => mapping(address => uint256))"
                        }
                      },
                      "id": 278,
                      "indexExpression": {
                        "argumentTypes": null,
                        "id": 277,
                        "name": "_owner",
                        "nodeType": "Identifier",
                        "overloadedDeclarations": [],
                        "referencedDeclaration": 269,
                        "src": "2698:6:1",
                        "typeDescriptions": {
                          "typeIdentifier": "t_address",
                          "typeString": "address"
                        }
                      },
                      "isConstant": false,
                      "isLValue": true,
                      "isPure": false,
                      "lValueRequested": false,
                      "nodeType": "IndexAccess",
                      "src": "2690:15:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_mapping$_t_address_$_t_uint256_$",
                        "typeString": "mapping(address => uint256)"
                      }
                    },
                    "id": 280,
                    "indexExpression": {
                      "argumentTypes": null,
                      "id": 279,
                      "name": "_spender",
                      "nodeType": "Identifier",
                      "overloadedDeclarations": [],
                      "referencedDeclaration": 271,
                      "src": "2706:8:1",
                      "typeDescriptions": {
                        "typeIdentifier": "t_address",
                        "typeString": "address"
                      }
                    },
                    "isConstant": false,
                    "isLValue": true,
                    "isPure": false,
                    "lValueRequested": false,
                    "nodeType": "IndexAccess",
                    "src": "2690:25:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "functionReturnParameters": 275,
                  "id": 281,
                  "nodeType": "Return",
                  "src": "2683:32:1"
                }
              ]
            },
            "id": 283,
            "implemented": true,
            "isConstructor": false,
            "isDeclaredConst": true,
            "modifiers": [],
            "name": "allowance",
            "nodeType": "FunctionDefinition",
            "parameters": {
              "id": 272,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 269,
                  "name": "_owner",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2599:14:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 268,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2599:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                },
                {
                  "constant": false,
                  "id": 271,
                  "name": "_spender",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2615:16:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_address",
                    "typeString": "address"
                  },
                  "typeName": {
                    "id": 270,
                    "name": "address",
                    "nodeType": "ElementaryTypeName",
                    "src": "2615:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_address",
                      "typeString": "address"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2598:34:1"
            },
            "payable": false,
            "returnParameters": {
              "id": 275,
              "nodeType": "ParameterList",
              "parameters": [
                {
                  "constant": false,
                  "id": 274,
                  "name": "remaining",
                  "nodeType": "VariableDeclaration",
                  "scope": 283,
                  "src": "2654:17:1",
                  "stateVariable": false,
                  "storageLocation": "default",
                  "typeDescriptions": {
                    "typeIdentifier": "t_uint256",
                    "typeString": "uint256"
                  },
                  "typeName": {
                    "id": 273,
                    "name": "uint256",
                    "nodeType": "ElementaryTypeName",
                    "src": "2654:7:1",
                    "typeDescriptions": {
                      "typeIdentifier": "t_uint256",
                      "typeString": "uint256"
                    }
                  },
                  "value": null,
                  "visibility": "internal"
                }
              ],
              "src": "2653:19:1"
            },
            "scope": 284,
            "src": "2580:142:1",
            "stateMutability": "view",
            "superFunction": 480,
            "visibility": "public"
          }
        ],
        "scope": 285,
        "src": "161:2566:1"
      }
    ],
    "src": "102:2626:1"
  },
  "compiler": {
    "name": "solc",
    "version": "0.4.19+commit.c4cbbb05.Emscripten.clang"
  },
  "networks": {},
  "schemaVersion": "2.0.0",
  "updatedAt": "2018-04-07T17:28:52.029Z"
}