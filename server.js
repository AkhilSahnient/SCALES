// server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ============ CORS MIDDLEWARE ============
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');
    res.header('Access-Control-Allow-Credentials', 'true');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    
    next();
});

// ============ CONFIGURATION ============
const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_API_TOKEN = process.env.BC_API_TOKEN;
const WEBHOOK_SECRET = process.env.BC_WEBHOOK_SECRET;
const DATE_ATTRIBUTE_ID = process.env.DATE_ATTRIBUTE_ID;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || 5; // Set this in your .env

const MIN_QUANTITY = 5;
const DISCOUNT_PERCENT = 35;
const DISCOUNT_DAYS = 90;

console.log('🔧 CONFIGURATION:');
console.log('  Store Hash:', BC_STORE_HASH);
console.log('  API Token:', BC_API_TOKEN ? '***' + BC_API_TOKEN.slice(-4) : 'MISSING');
console.log('  Webhook Secret:', WEBHOOK_SECRET ? 'SET' : 'NOT SET');
console.log('  Date Attribute ID:', DATE_ATTRIBUTE_ID);
console.log('  VIP Group ID:', VIP_GROUP_ID);
console.log('  Min Quantity:', MIN_QUANTITY);
console.log('  Discount:', DISCOUNT_PERCENT + '%');
console.log('  Discount Days:', DISCOUNT_DAYS);
console.log('');

// ============ IN-MEMORY STORES ============
const recentlyQualified = new Map();
const processedWebhooks = new Set();

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
    console.log('💚 Health check');
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        config: {
            storeHash: BC_STORE_HASH,
            hasApiToken: !!BC_API_TOKEN,
            hasWebhookSecret: !!WEBHOOK_SECRET,
            dateAttributeId: DATE_ATTRIBUTE_ID,
            vipGroupId: VIP_GROUP_ID,
            minQuantity: MIN_QUANTITY
        }
    });
});

// ============ POPUP CHECK ENDPOINT ============
app.get('/api/just-qualified/:customerId', (req, res) => {
    const customerId = parseInt(req.params.customerId);
    const qualified = recentlyQualified.has(customerId);
    
    console.log(`🔍 Popup check for customer ${customerId}: ${qualified ? 'SHOW' : 'HIDE'}`);
    
    if (qualified) {
        recentlyQualified.delete(customerId);
    }
    
    res.json({ justQualified: qualified });
});

// ============ HELPER: CHECK IF CUSTOMER IS QUALIFIED ============
async function checkIfQualified(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?customer_id:in=${customerId}`;
    
    try {
        const response = await axios.get(url, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const attributeValues = response.data.data || [];
        const dateAttr = attributeValues.find(av => 
            av.customer_id === customerId && av.attribute_id === parseInt(DATE_ATTRIBUTE_ID)
        );
        
        return dateAttr?.attribute_value || null;
    } catch (error) {
        console.error('   Error checking qualification:', error.message);
        return null;
    }
}

// ============ HELPER: SET QUALIFIED DATE ============
async function setQualifiedDate(customerId, date) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`;
    
    const payload = [{
        customer_id: customerId,
        attribute_id: parseInt(DATE_ATTRIBUTE_ID),
        value: date
    }];
    
    try {
        await axios.put(url, payload, { 
            headers: {
                'X-Auth-Token': BC_API_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        return true;
    } catch (error) {
        console.error('   Error setting date:', error.message);
        return false;
    }
}

// ============ HELPER: ADD CUSTOMER TO VIP GROUP ============
async function addToVIPGroup(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers`;
    
    const payload = [{
        id: customerId,
        customer_group_id: parseInt(VIP_GROUP_ID)
    }];
    
    try {
        await axios.put(url, payload, { 
            headers: {
                'X-Auth-Token': BC_API_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log(`   ✅ Added to VIP group ${VIP_GROUP_ID}`);
        return true;
    } catch (error) {
        console.error('   Error adding to VIP group:', error.message);
        return false;
    }
}

// ============ HELPER: REMOVE CUSTOMER FROM VIP GROUP ============
async function removeFromVIPGroup(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers`;
    
    const payload = [{
        id: customerId,
        customer_group_id: 0  // 0 = default group
    }];
    
    try {
        await axios.put(url, payload, { 
            headers: {
                'X-Auth-Token': BC_API_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log(`   ✅ Removed from VIP group`);
        return true;
    } catch (error) {
        console.error('   Error removing from VIP group:', error.message);
        return false;
    }
}

// ============ WEBHOOK ENDPOINT ============
app.post('/webhook', async (req, res) => {
    // Deduplication code stays same...
    
    const { scope, data } = req.body;
    console.log('📥 WEBHOOK:', scope);
    
    try {
        // ============ ORDER CREATED (VIP QUALIFICATION) ============
        if (scope === 'store/order/created') {
            const orderId = data.id;
            console.log('📦 Processing order:', orderId);
            
            // Your existing order fetching logic...
            const customerId = order.customer_id;
            
            if (!customerId || customerId === 0) {
                console.log('   ℹ️ Guest - skipping');
                return res.sendStatus(200);
            }
            
            const totalQty = products.reduce((sum, p) => sum + p.quantity, 0);
            console.log(`   Total qty: ${totalQty}`);
            
            if (totalQty >= MIN_QUANTITY) {
                console.log(`   🎉 QUALIFYING ${customerId}!`);
                
                // CRITICAL: Check existing qualification
                const existingDate = await checkIfQualified(customerId);
                if (existingDate) {
                    console.log(`   ℹ️ Already qualified: ${existingDate}`);
                    return res.sendStatus(200);
                }
                
                // ADD TO VIP GROUP (this was missing!)
                const today = new Date().toISOString().split('T')[0];
                console.log(`   📅 Setting date: ${today}`);
                
                const dateSet = await setQualifiedDate(customerId, today);
                const groupAdded = await addToVIPGroup(customerId);  // ← This line runs NOW
                
                console.log(`   Date: ${dateSet ? '✅' : '❌'}, Group: ${groupAdded ? '✅' : '❌'}`);
            }
            return res.sendStatus(200);  // ← Move return INSIDE if block
        }
        
        // ============ CART CONVERTED (REMOVE VIP AFTER USE) ============
        if (scope === 'store/cart/converted') {  // ← Changed to if, not else if
            console.log('💰 Cart converted, checking VIP usage...');
            const orderId = data.orderId || data.id;
            
            // Your existing cart converted logic...
            return res.sendStatus(200);
        }
        
    } catch (error) {
        console.error('❌ WEBHOOK ERROR:', error.response?.data || error.message);
        res.sendStatus(500);
    }
    
    res.sendStatus(200);
});


// ============ CLEANUP ============
setInterval(() => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [id, ts] of recentlyQualified.entries()) {
        if (ts < expiry) recentlyQualified.delete(id);
    }
}, 60 * 1000);


// test route for Railway
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

// CRITICAL: Must bind to '0.0.0.0' for Railway
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} (0.0.0.0)`);
    console.log(`   Health check: /health`);
    console.log(`   Webhook endpoint: /webhook`);
});