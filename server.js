const express = require('express')
const twilio = require('twilio')
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const bp = require('body-parser')
const mongodb = require('mongodb')
const libphonenumber = require('libphonenumber-js')

const app = express()
app.use(bp.urlencoded({ extended: false }))
app.use(bp.json())

let db = null

const dbConnect = () => {
  return new Promise((resolve, reject) => {
    if (db) {
      console.log('=> using cached db')
      resolve()
    } else {
      mongodb.MongoClient.connect('mongodb://localhost/tracker', {
        useUnifiedTopology: true
      }).then(client => {
          console.log('=> connected to the database')
          db = client.db()
          resolve()
        }).catch(err => {
          console.error('=> unable to connecto to db:', err.message ? err.message : JSON.stringify(err))
          reject(err)
        })
    }
  })
}

const priceMap = {
  us: {
    us: 0.0200,
    br: 0.0570
  }
}

const getCountryFromPhoneNumber = (phoneNumber) => {
  return libphonenumber.parsePhoneNumber(phoneNumber).country
}

const getMessageCostData = (fromNumber, toNumber, numSegments) => {
  const fromCountry = getCountryFromPhoneNumber(fromNumber).toLowerCase()
  const toCountry = getCountryFromPhoneNumber(toNumber).toLowerCase()
  const segmentCost = priceMap[fromCountry][toCountry]
  const totalCost = segmentCost * numSegments

  console.log(`FROM ${fromNumber} (${fromCountry}) TO ${toNumber} (${toCountry}) => ${totalCost}`)

  return {
    fromCountry, toCountry, segmentCost, totalCost
  }
}

app.post('/sms', (req, res) => {
  const { from, to, body } = req.body

  console.log(JSON.stringify(req.body,null,2))

  client.messages.create({
    from, to, statusCallback: 'https://trazzini.ngrok.io/status', body
  }).then(result => {
    console.log(JSON.stringify(result,null,2))

    const { sid, numSegments, dateCreated } = result

    return dbConnect().then(() => {
      return db.collection('log').insertOne({
        _id: sid, numSegments, from, to, dateCreated
      })
    }).catch(console.error)

  }).then(result => {
    res.status(200).send(result)
  }).catch(err => {
    console.log('Error sending message:', err.message)
    res.status(500).send({ messsage: err.message })
  })
})

app.post('/status', (req, res) => {
  console.log('STATUS UPDATE RECEIVED')
  console.log(JSON.stringify(req.body,null,2))

  const { SmsSid, SmsStatus, Price } = req.body

  if (SmsStatus == 'sent') {
    dbConnect().then(() => {
      return db.collection('log').findOne({ _id: SmsSid })
    }).then(result => {
      const { from, to, numSegments } = result
      const { fromCountry, toCountry, segmentCost, totalCost } = 
        getMessageCostData(from, to, numSegments)

      return db.collection('log').updateOne({
        _id: SmsSid
      }, {
        $set: {
          fromCountry, toCountry, segmentCost, totalCost
        },
        $currentDate: { lastModified: true }
      })
    }).then(() => {
      res.status(201).send()
    }).catch(console.error)
  } else if (SmsStatus == 'delivered' && Price) {

    console.log(`NEW PRICE for ${SmsSid}: ${Price}`)

    dbConnect().then(() => {
      return db.collection('log').updateOne({
        _id: SmsSid
      }, {
        $set: {
          totalCost: Price,
          costSetByCallback: true
        },
        $currentDate: { lastModified: true }
      })
    }).then(() => {
      res.status(201).send()
    }).catch(console.error)
  }

})

app.listen(3000, () => {
  console.log('server is up and running on port 3000...')
})
