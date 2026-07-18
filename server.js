require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
// Make sure to get your secret key from the Stripe dashboard
let stripe = null;
try {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch (error) {
    console.warn('Stripe package not installed or unavailable. Payment intent support is disabled.');
}

const app = express();

// Serve static files (HTML, CSS, images) from the root directory
app.use(express.static(path.join(__dirname)));

// --- Database Connection ---
// Use the cloud database URI in production, or the local one for development
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sneakers_db')
...
                Password: password,
                Timestamp: timestamp,
                TransactionType: 'CustomerPayBillOnline',
                Amount: Math.round(amount),
                PartyA: normalizedPhone,
                PartyB: config.shortcode,
                PhoneNumber: normalizedPhone,
                CallBackURL: config.callbackUrl,
                AccountReference: 'MrKicks',
                TransactionDesc: 'Payment for sneakers',
            },
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const checkoutRequestID = response.data.CheckoutRequestID;
        // Create a pending transaction record in the database
...
    });
});

// New endpoint for the frontend to poll
app.get('/payment-status/:checkoutId', async (req, res) => {
    const checkoutId = req.params.checkoutId;
    const transaction = await Transaction.findOne({ checkoutRequestID: checkoutId });

    if (!transaction) {
        return res.status(404).send({ status: 'not_found' });
    }
    res.send({ status: transaction.status });
});

// Heroku provides the port via an environment variable
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Node server listening on port ${PORT}`));