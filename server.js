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
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || 5;

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
    // Deduplication
    const webhookId = `${req.body.scope}-${req.body.data?.id}-${req.body.created_at}`;
    
    if (processedWebhooks.has(webhookId)) {
        console.log('⏭️  Duplicate webhook - skipping');
        return res.sendStatus(200);
    }
    
    processedWebhooks.add(webhookId);
    setTimeout(() => processedWebhooks.delete(webhookId), 60000);
    
    console.log('\n📥 WEBHOOK RECEIVED:', new Date().toISOString());
    console.log('Scope:', req.body.scope);
    console.log('Data:', JSON.stringify(req.body.data, null, 2));
    
    try {
        const { scope, data } = req.body;
        
        // ============ ORDER CREATED HANDLER ============
        if (scope === 'store/order/created') {
            const orderId = data.id;
            console.log('📦 Order created:', orderId);
            
            // Fetch order details
            console.log('🔍 Fetching order details...');
            const orderUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v2/orders/${orderId}`;
            const headers = { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' };
            
            const orderResponse = await axios.get(orderUrl, { headers });
            const order = orderResponse.data;
            const customerId = order.customer_id;
            
            console.log('   Customer ID:', customerId);
            
            if (!customerId || customerId === 0) {
                console.log('   ℹ️  Guest order - skipping\n');
                return res.sendStatus(200);
            }
            
            // Check if customer is currently in VIP group
            const customerUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?id:in=${customerId}`;
            const customerResponse = await axios.get(customerUrl, { 
                headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
            });
            
            const customer = customerResponse.data.data[0];
            const isInVIPGroup = customer && customer.customer_group_id === parseInt(VIP_GROUP_ID);
            
            if (isInVIPGroup) {
                // Customer is in VIP group - they just used their discount
                console.log('   🎫 Customer is in VIP group - they used their discount');
                console.log('   ✅ Removing from VIP group (can qualify again with next 5+ order)');
                
                await removeFromVIPGroup(customerId);
                
                // Delete qualification date attribute value
                try {
                    // First get the attribute value ID
                    const getAttrUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?customer_id:in=${customerId}`;
                    const getAttrResponse = await axios.get(getAttrUrl, {
                        headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
                    });
                    
                    const attrValues = getAttrResponse.data.data || [];
                    const ourAttr = attrValues.find(av => av.attribute_id === parseInt(DATE_ATTRIBUTE_ID));
                    
                    if (ourAttr) {
                        // Delete using the attribute value ID
                        const deleteAttrUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?id:in=${ourAttr.id}`;
                        await axios.delete(deleteAttrUrl, {
                            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
                        });
                        console.log('   ✅ Deleted qualification date\n');
                    } else {
                        console.log('   ℹ️  No qualification date to delete\n');
                    }
                } catch (err) {
                    console.log('   ⚠️  Could not delete date:', err.message, '\n');
                }
                
                return res.sendStatus(200);
            }
            
            // Customer is NOT in VIP group - check if this order qualifies them
            
            // Fetch order products
            console.log('📦 Fetching products...');
            const productsUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v2/orders/${orderId}/products`;
            const productsResponse = await axios.get(productsUrl, { headers });
            const products = productsResponse.data;
            
            const totalQty = products.reduce((sum, p) => {
                console.log(`   - ${p.name}: qty ${p.quantity}`);
                return sum + p.quantity;
            }, 0);
            
            console.log(`   ✅ Total quantity: ${totalQty}`);
            
            if (totalQty < MIN_QUANTITY) {
                console.log(`   ℹ️  Not qualifying (${totalQty} < ${MIN_QUANTITY})\n`);
                return res.sendStatus(200);
            }
            
            console.log(`   🎉 Order qualifies for VIP discount on NEXT order!`);
            
            // Qualify customer for NEXT order
            const today = new Date().toISOString().split('T')[0];
            console.log(`\n🎊 QUALIFYING CUSTOMER ${customerId} for their NEXT order!`);
            console.log(`   Date: ${today}`);
            
            // Set qualified date
            const dateSuccess = await setQualifiedDate(customerId, today);
            
            // Add to VIP group
            const groupSuccess = await addToVIPGroup(customerId);
            
            if (dateSuccess && groupSuccess) {
                // Verify
                await new Promise(resolve => setTimeout(resolve, 1000));
                const verifyDate = await checkIfQualified(customerId);
                
                if (verifyDate) {
                    console.log(`   ✅ CONFIRMED: ${verifyDate}`);
                    console.log(`   🎫 Customer will see 35% off on their NEXT order\n`);
                    recentlyQualified.set(customerId, Date.now());
                } else {
                    console.log('   ⚠️  Could not verify attribute\n');
                }
            } else {
                console.log('   ❌ Failed to fully qualify customer\n');
            }
        }
        
        // No cart/converted handler - timing issues
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        }
        console.log('');
        res.sendStatus(500);
    }
});

// ============ CLEANUP ============
setInterval(() => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [id, ts] of recentlyQualified.entries()) {
        if (ts < expiry) recentlyQualified.delete(id);
    }
}, 60 * 1000);

// Test route for Railway
app.get("/", (req, res) => {
  res.send("VIP Wholesale Discount Server 🚀");
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} (0.0.0.0)`);
    console.log(`   Health check: /health`);
    console.log(`   Webhook endpoint: /webhook`);
});
