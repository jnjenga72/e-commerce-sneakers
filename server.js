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

// --- Database Connection ---
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/sneakers_db')
    .then(() => console.log('MongoDB connected...'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose Schema and Model ---
const transactionSchema = new mongoose.Schema({
    checkoutRequestID: { type: String, required: true, unique: true, index: true },
    resultCode: Number,
    resultDesc: String,
    amount: Number,
    mpesaReceiptNumber: String,
    transactionDate: Date,
    phoneNumber: String,
    status: { type: String, enum: ['pending', 'success', 'failed', 'not_found'], default: 'pending' }
}, { timestamps: true });

const Transaction = mongoose.model('Transaction', transactionSchema);

const normalizePhoneNumber = (phoneNumber) => {
    const cleaned = String(phoneNumber).trim();
    if (!cleaned) return '';

    const digits = cleaned.replace(/\D/g, '');
    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return `254${digits.slice(1)}`;
    return digits;
};

const isPlaceholderValue = (value) => {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return !normalized || normalized.includes('your_') || normalized.includes('your ') || normalized.includes('...') || normalized.includes('placeholder');
};

const getMpesaConfig = () => {
    const config = {
        consumerKey: process.env.MPESA_CONSUMER_KEY,
        consumerSecret: process.env.MPESA_CONSUMER_SECRET,
        shortcode: process.env.MPESA_SHORTCODE,
        passkey: process.env.MPESA_PASSKEY,
        callbackUrl: process.env.MPESA_CALLBACK_URL || 'http://localhost:4242/daraja-callback',
    };

    const missing = Object.entries(config)
        .filter(([key, value]) => ['consumerKey', 'consumerSecret', 'shortcode', 'passkey'].includes(key) && !value)
        .map(([key]) => key);

    const placeholders = Object.entries(config)
        .filter(([key, value]) => ['consumerKey', 'consumerSecret', 'shortcode', 'passkey'].includes(key) && isPlaceholderValue(value))
        .map(([key]) => key);

    return { config, missing, placeholders, isConfigured: missing.length === 0 && placeholders.length === 0 };
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

app.post('/create-payment-intent', async (req, res) => {
    if (!stripe) {
        return res.status(503).json({ error: 'Stripe payments are unavailable in this environment.' });
    }

    const { amount } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).send({ error: 'Invalid amount' });
    }

    try {
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amount * 100,
            currency: 'kes',
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.send({
            clientSecret: paymentIntent.client_secret,
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

const getDarajaToken = async () => {
    const { config, missing, placeholders } = getMpesaConfig();
    if (missing.length || placeholders.length) {
        const issues = [...missing, ...placeholders];
        throw new Error(`M-Pesa credentials are incomplete. Missing or placeholder: ${issues.join(', ')}`);
    }

    const auth = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');

    try {
        const response = await axios.get('https://safaricom.co.ke', {
            headers: {
                Authorization: `Basic ${auth}`,
            },
        });
        return response.data.access_token;
    } catch (error) {
        console.error('Failed to get Daraja token:', error.response ? error.response.data : error.message);
        throw new Error('Failed to get Daraja token');
    }
};

app.post('/initiate-mpesa-payment', async (req, res) => {
    const { amount, phoneNumber } = req.body;

    if (!amount || !phoneNumber) {
        return res.status(400).send({ error: 'Amount and phone number are required.' });
    }

    const normalizedPhone = normalizePhoneNumber(phoneNumber);
    if (!normalizedPhone || normalizedPhone.length < 12) {
        return res.status(400).send({ error: 'Please enter a valid Kenyan phone number, for example 07xxxxxxxx.' });
    }

    try {
        const { config, missing, placeholders } = getMpesaConfig();
        if (missing.length || placeholders.length) {
            return res.status(400).send({
                error: 'M-Pesa is not configured yet.',
                missingConfig: missing,
                placeholderConfig: placeholders,
                message: 'Add your real Daraja sandbox credentials to the environment variables before testing payments.'
            });
        }

        const token = await getDarajaToken();
        const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
        const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');

        const response = await axios.post(
            'https://safaricom.co.ke',
            {
                BusinessShortCode: config.shortcode,
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
        
        await Transaction.create({
            checkoutRequestID: checkoutRequestID,
            phoneNumber: normalizedPhone,
            amount: Math.round(amount),
            status: 'pending'
        });

        res.send({
            message: 'STK push initiated successfully',
            checkoutId: checkoutRequestID
        });

    } catch (error) {
        console.error('M-Pesa payment initiation failed:', error.message);
        res.status(500).send({ error: error.message });
    }
});

app.get('/payment-status/:checkoutId', async (req, res) => {
    const checkoutId = req.params.checkoutId;
    const transaction = await Transaction.findOne({ checkoutRequestID: checkoutId });

    if (!transaction) {
        return res.status(404).send({ status: 'not_found' });
    }
    res.send({ status: transaction.status });
});

app.post('/daraja-callback', async (req, res) => {
    const callbackData = req.body.Body.stkCallback;
    const checkoutId = callbackData.CheckoutRequestID;
    const resultCode = callbackData.ResultCode;
    const resultDesc = callbackData.ResultDesc;

    let transactionUpdate = {
        resultCode,
        resultDesc,
        status: resultCode === 0 ? 'success' : 'failed'
    };

    if (resultCode === 0 && callbackData.CallbackMetadata) {
        const items = callbackData.CallbackMetadata.Item;
        const mpesaReceipt = items.find(item => item.Name === 'MpesaReceiptNumber');
        const transDate = items.find(item => item.Name === 'TransactionDate');
        
        if (mpesaReceipt) transactionUpdate.mpesaReceiptNumber = mpesaReceipt.Value;
        if (transDate) transactionUpdate.transactionDate = transDate.Value;
    }

    await Transaction.findOneAndUpdate(
        { checkoutRequestID: checkoutId },
        transactionUpdate
    );
    res.send({ ResultCode: 0, ResultDesc: "Accepted successfully" });
});

// Explicit root route handler to serve frontend index.html on Vercel deployment
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
