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
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ============ CONFIGURATION ============
const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_API_TOKEN = process.env.BC_API_TOKEN;
const WEBHOOK_SECRET = process.env.BC_WEBHOOK_SECRET;
const DATE_ATTRIBUTE_ID = process.env.DATE_ATTRIBUTE_ID;
const VIP_GROUP_ID = process.env.VIP_GROUP_ID || 2;

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
//const recentlyQualified = new Map();
const processedWebhooks = new Set();

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        config: {
            storeHash: BC_STORE_HASH,
            hasApiToken: !!BC_API_TOKEN,
            hasWebhookSecret: !!WEBHOOK_SECRET,
            dateAttributeId: DATE_ATTRIBUTE_ID,
            vipGroupId: VIP_GROUP_ID,
            minQuantity: MIN_QUANTITY,
            discountPercent: DISCOUNT_PERCENT,
            discountDays: DISCOUNT_DAYS
        }
    });
});

// ============ POPUP CHECK ENDPOINT ============
// app.get('/api/just-qualified/:customerId', (req, res) => {
//     const customerId = parseInt(req.params.customerId);
//     const qualified = recentlyQualified.has(customerId);
//     console.log(`🔍 Popup check for customer ${customerId}: ${qualified ? 'SHOW' : 'HIDE'}`);
//     if (qualified) recentlyQualified.delete(customerId);
//     res.json({ justQualified: qualified });
// });


// ============ POPUP CHECK ENDPOINT (PRODUCTION SAFE) ============
app.get('/api/just-qualified/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    try {
        const expiry = await checkExpiry(customerId);
        
        if (expiry.expired || !expiry.qualifiedDate) {
            console.log(`🔍 ${customerId}: EXPIRED (${expiry.daysSince?.toFixed(1)} days)`);
            return res.json({ justQualified: false, status: 'expired' });
        }
        
        const justQualified = true;  // Show for ALL active VIPs
        console.log(`🔍 ${customerId}: ACTIVE VIP (${expiry.daysLeft.toFixed(1)} days left) → SHOW`);
        
        res.json({ 
            justQualified: true,
            daysLeft: expiry.daysLeft,
            discountPercent: DISCOUNT_PERCENT,
            expires: expiry.qualifiedDate 
        });
        
    } catch (error) {
        console.error('Popup error:', error);
        res.json({ justQualified: false });
    }
});


// ============ HELPER: GET QUALIFICATION ATTRIBUTE ============
async function getQualificationAttribute(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?customer_id:in=${customerId}`;
    try {
        const response = await axios.get(url, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        const attributeValues = response.data.data || [];
        return attributeValues.find(av => 
            av.customer_id === customerId && av.attribute_id === parseInt(DATE_ATTRIBUTE_ID)
        ) || null;
    } catch (error) {
        console.error('   Error getting attribute:', error.message);
        return null;
    }
}

// ============ HELPER: CHECK IF QUALIFIED ============
async function checkIfQualified(customerId) {
    const attr = await getQualificationAttribute(customerId);
    return attr?.attribute_value || null;
}

// ============ HELPER: CHECK EXPIRY ============
async function checkExpiry(customerId) {
    const attr = await getQualificationAttribute(customerId);
    if (!attr || !attr.attribute_value) {
        return { expired: true, daysLeft: 0, qualifiedDate: null, attrId: null };
    }
    const daysDiff = (Date.now() - new Date(attr.attribute_value).getTime()) / (1000 * 60 * 60 * 24);
    return {
        expired: daysDiff > DISCOUNT_DAYS,
        daysLeft: Math.max(0, DISCOUNT_DAYS - daysDiff),
        daysSince: daysDiff,
        qualifiedDate: attr.attribute_value,
        attrId: attr.id
    };
}

// ============ HELPER: SET QUALIFIED DATE ============
async function setQualifiedDate(customerId, date) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`;
    try {
        await axios.put(url, [{
            customer_id: customerId,
            attribute_id: parseInt(DATE_ATTRIBUTE_ID),
            value: date
        }], { 
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

// ============ HELPER: DELETE QUALIFICATION DATE ============
async function deleteQualificationDate(customerId) {
    try {
        const attr = await getQualificationAttribute(customerId);
        if (!attr) {
            console.log('   ℹ️  No qualification date to delete');
            return true;
        }
        const deleteUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?id:in=${attr.id}`;
        await axios.delete(deleteUrl, {
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        console.log('   ✅ Deleted qualification date');
        return true;
    } catch (error) {
        console.error('   Error deleting date:', error.message);
        return false;
    }
}

// ============ HELPER: ADD TO VIP GROUP ============
async function addToVIPGroup(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers`;
    try {
        await axios.put(url, [{ id: customerId, customer_group_id: parseInt(VIP_GROUP_ID) }], { 
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

// ============ HELPER: REMOVE FROM VIP GROUP ============
async function removeFromVIPGroup(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers`;
    try {
        await axios.put(url, [{ id: customerId, customer_group_id: 0 }], { 
            headers: {
                'X-Auth-Token': BC_API_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        console.log('   ✅ Removed from VIP group');
        return true;
    } catch (error) {
        console.error('   Error removing from VIP group:', error.message);
        return false;
    }
}

// ============ DAILY EXPIRY CHECK ============
async function checkExpiredVIPCustomers() {
    console.log('\n🔍 Running expiry check...');
    try {
        const attrUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`;
        const attrResponse = await axios.get(attrUrl, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const allAttributes = attrResponse.data.data || [];
        const qualifiedCustomers = allAttributes.filter(a => 
            a.attribute_id === parseInt(DATE_ATTRIBUTE_ID) && a.attribute_value
        );
        
        console.log(`   Found ${qualifiedCustomers.length} qualified customer(s)`);
        
        let expiredCount = 0;
        for (const attr of qualifiedCustomers) {
            const daysDiff = (Date.now() - new Date(attr.attribute_value).getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff > DISCOUNT_DAYS) {
                console.log(`   ⏰ Customer ${attr.customer_id} expired (${daysDiff.toFixed(0)} days)`);
                await removeFromVIPGroup(attr.customer_id);
                const deleteUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?id:in=${attr.id}`;
                await axios.delete(deleteUrl, {
                    headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
                });
                expiredCount++;
            }
        }
        
        console.log(expiredCount === 0 
            ? '   ✅ No expired customers\n' 
            : `   ✅ Removed ${expiredCount} expired customer(s)\n`
        );
    } catch (error) {
        console.error('   ❌ Error in expiry check:', error.message);
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
    
    try {
        const { scope, data } = req.body;
        
        // ============ ORDER CREATED HANDLER ============
        if (scope === 'store/order/created') {
            const orderId = data.id;
            console.log('📦 Order created:', orderId);
            
            // Fetch order details
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
            
            console.log(`   VIP group: ${isInVIPGroup} (group_id: ${customer?.customer_group_id})`);
            
            // ---- CASE 1: Customer IS in VIP group - check if expired ----
            if (isInVIPGroup) {
                const expiry = await checkExpiry(customerId);
                
                if (expiry.expired) {
                    console.log(`   ⏰ VIP discount expired (${expiry.daysSince?.toFixed(0)} days since qualification)`);
                    console.log('   Removing from VIP group...');
                    
                    // Remove from VIP group
                    await removeFromVIPGroup(customerId);
                    
                    // Delete qualification date
                    await deleteQualificationDate(customerId);
                    
                    console.log('   ✅ Discount expired - customer can re-qualify with next 5+ item order\n');
                } else {
                    console.log(`   ✅ Customer using VIP discount (${expiry.daysLeft.toFixed(0)} days remaining)`);
                    console.log(`   🎫 Customer keeps 35% off for ${expiry.daysLeft.toFixed(0)} more days\n`);
                }
                
                return res.sendStatus(200);
            }
            
            // ---- CASE 2: Customer NOT in VIP group - check if this order qualifies them ----
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
            
            // Qualify customer for NEXT order
            const today = new Date().toISOString().split('T')[0];
            const expiryDate = new Date(Date.now() + DISCOUNT_DAYS * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            
            console.log(`\n🎊 QUALIFYING CUSTOMER ${customerId}!`);
            console.log(`   Qualified: ${today}`);
            console.log(`   Expires:   ${expiryDate} (${DISCOUNT_DAYS} days)`);
            
            const dateSuccess = await setQualifiedDate(customerId, today);
            const groupSuccess = await addToVIPGroup(customerId);
            
            if (dateSuccess && groupSuccess) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const verifyDate = await checkIfQualified(customerId);
                
                if (verifyDate) {
                    console.log(`   ✅ CONFIRMED: ${verifyDate}`);
                    console.log(`   🎫 Customer will see ${DISCOUNT_PERCENT}% off on their NEXT order\n`);
                    //recentlyQualified.set(customerId, Date.now());
                } else {
                    console.log('   ⚠️  Could not verify\n');
                }
            } else {
                console.log('   ❌ Failed to qualify customer\n');
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
            console.error('   Data:', JSON.stringify(error.response.data, null, 2));
        }
        res.sendStatus(500);
    }
});

// ============ CLEANUP IN-MEMORY ============
// setInterval(() => {
//     const expiry = Date.now() - 10 * 60 * 1000;
//     for (const [id, ts] of recentlyQualified.entries()) {
//         if (ts < expiry) recentlyQualified.delete(id);
//     }
// }, 60 * 1000);

// ============ RUN EXPIRY CHECK ============
checkExpiredVIPCustomers();
setInterval(checkExpiredVIPCustomers, 24 * 60 * 60 * 1000);

// ============ ROOT ROUTE ============
app.get('/', (req, res) => res.send('VIP Wholesale Discount Server 🚀'));

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('   Health:  /health');
    console.log('   Webhook: /webhook\n');
});