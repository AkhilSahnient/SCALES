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
            
            console.log(`   🎉 Order qualifies!`);
            
            // Check if already qualified
            console.log('📅 Checking if already qualified...');
            const existingDate = await checkIfQualified(customerId);
            
            if (existingDate) {
                console.log(`   ℹ️  Already qualified on ${existingDate}\n`);
                return res.sendStatus(200);
            }
            
            // Qualify customer
            const today = new Date().toISOString().split('T')[0];
            console.log(`\n🎊 QUALIFYING CUSTOMER ${customerId}!`);
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
                    console.log(`   Valid until: ${new Date(Date.now() + DISCOUNT_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}`);
                    console.log(`   🎫 Customer will see discounted prices automatically\n`);
                    recentlyQualified.set(customerId, Date.now());
                } else {
                    console.log('   ⚠️  Could not verify attribute\n');
                }
            } else {
                console.log('   ❌ Failed to fully qualify customer\n');
            }
        }
        
        // ============ CHECK FOR EXPIRED DISCOUNTS (Daily) ============
        // This would be better as a separate cron job, but for now we check on each webhook
        else if (scope === 'store/order/created' && Math.random() < 0.1) {
            // 10% chance to check for expirations
            console.log('🔍 Checking for expired VIP customers...');
            
            const attrUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`;
            const attrResponse = await axios.get(attrUrl, { 
                headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
            });
            
            const allAttributes = attrResponse.data.data || [];
            const qualifiedCustomers = allAttributes.filter(a => a.attribute_id === parseInt(DATE_ATTRIBUTE_ID));
            
            for (const attr of qualifiedCustomers) {
                const qualifiedDate = attr.attribute_value;
                const daysDiff = (Date.now() - new Date(qualifiedDate).getTime()) / (1000 * 60 * 60 * 24);
                
                if (daysDiff > DISCOUNT_DAYS) {
                    console.log(`   ⏰ Customer ${attr.customer_id} expired (${daysDiff.toFixed(0)} days)`);
                    await removeFromVIPGroup(attr.customer_id);
                }
            }
        }
        
        // ============ CART CONVERTED HANDLER ============
        else if (scope === 'store/cart/converted') {
            console.log('💰 Cart converted');
            console.log('   Data:', JSON.stringify(data, null, 2));
            
            // The webhook data structure is different - we need to extract order_id
            const orderId = data.orderId || data.order_id || data.id;
            
            if (!orderId) {
                console.log('   ⚠️  No order ID found in webhook\n');
                return res.sendStatus(200);
            }
            
            console.log('   Order ID:', orderId);
            
            try {
                // Fetch order to get customer ID
                const orderUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v2/orders/${orderId}`;
                const orderResponse = await axios.get(orderUrl, { 
                    headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
                });
                
                const order = orderResponse.data;
                const customerId = order.customer_id;
                
                if (!customerId || customerId === 0) {
                    console.log('   ℹ️  Guest order\n');
                    return res.sendStatus(200);
                }
                
                console.log('   Customer ID:', customerId);
                
                // Check if customer is in VIP group
                const customerUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?id:in=${customerId}`;
                const customerResponse = await axios.get(customerUrl, { 
                    headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
                });
                
                const customer = customerResponse.data.data[0];
                
                if (customer && customer.customer_group_id === parseInt(VIP_GROUP_ID)) {
                    console.log('   🎫 Customer is in VIP group - removing after using discount');
                    
                    // Remove from VIP group
                    await removeFromVIPGroup(customerId);
                    
                    // Clear the qualified date (optional - allows re-qualification)
                    try {
                        const clearUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`;
                        await axios.put(clearUrl, [{
                            customer_id: customerId,
                            attribute_id: parseInt(DATE_ATTRIBUTE_ID),
                            value: '' // Clear the date
                        }], { 
                            headers: {
                                'X-Auth-Token': BC_API_TOKEN,
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            }
                        });
                        console.log('   ✅ Cleared qualification date');
                    } catch (err) {
                        console.log('   ⚠️  Could not clear date (may not exist)');
                    }
                    
                    console.log('   ✅ VIP discount used - customer can qualify again\n');
                } else {
                    console.log('   ℹ️  Customer not in VIP group (may not have qualified)\n');
                }
                
            } catch (error) {
                console.error('   ❌ Error processing cart conversion:', error.message);
                if (error.response) {
                    console.error('   Status:', error.response.status);
                    console.error('   Data:', JSON.stringify(error.response.data, null, 2));
                }
                console.log('');
            }
        }
        
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

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;

// CRITICAL: Must bind to '0.0.0.0' for Railway
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT} (0.0.0.0)`);
    console.log(`   Health check: /health`);
    console.log(`   Webhook endpoint: /webhook`);
});