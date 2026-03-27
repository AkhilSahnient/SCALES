
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

const MIN_QUANTITY = 2000;
const DISCOUNT_PERCENT = 35;
//const DISCOUNT_MINUTES = 5;  // 5 minutes expiry
//const DISCOUNT_MS = DISCOUNT_MINUTES * 60 * 1000; // Convert to milliseconds for accurate checking
const DISCOUNT_DAYS = parseFloat(process.env.DISCOUNT_DAYS) || 90;
const DISCOUNT_MINUTES = DISCOUNT_DAYS * 24 * 60;


console.log('CONFIGURATION:');
console.log('  Store Hash:', BC_STORE_HASH);
console.log('  API Token:', BC_API_TOKEN ? '***' + BC_API_TOKEN.slice(-4) : 'MISSING');
console.log('  Date Attribute ID:', DATE_ATTRIBUTE_ID);
console.log('  VIP Group ID:', VIP_GROUP_ID);
console.log('  Min Quantity:', MIN_QUANTITY);
console.log('  Discount:', DISCOUNT_PERCENT + '%');
console.log('  Discount Minutes:', DISCOUNT_MINUTES);
console.log('');

// ============ IN-MEMORY STORES ============
const recentlyQualified = new Map();
const processedWebhooks = new Set();

// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        config: {
            storeHash: BC_STORE_HASH,
            hasApiToken: !!BC_API_TOKEN,
            dateAttributeId: DATE_ATTRIBUTE_ID,
            vipGroupId: VIP_GROUP_ID,
            minQuantity: MIN_QUANTITY,
            discountPercent: DISCOUNT_PERCENT,
            discountMinutes: DISCOUNT_MINUTES
        }
    });
});

// ============ VIP INFO ENDPOINT ============
app.get('/api/vip-info', (req, res) => {
    res.json({
        vipGroupId: parseInt(VIP_GROUP_ID),
        discountPercent: DISCOUNT_PERCENT,
        minQuantity: MIN_QUANTITY,
        discountMinutes: DISCOUNT_MINUTES
    });
});

// ============ HELPER: CHECK EXPIRY (UPDATED FOR MINUTES) ============
async function checkExpiry(customerId) {
    const attr = await getQualificationAttribute(customerId);
    if (!attr || !attr.attribute_value) {
        return { 
            expired: true, 
            minutesLeft: 0, 
            qualifiedDate: null, 
            attrId: null 
        };
    }
    
    const qualifiedTime = new Date(attr.attribute_value).getTime();
    const currentTime = Date.now();
    const elapsedMs = currentTime - qualifiedTime;
    const elapsedMinutes = elapsedMs / (1000 * 60);
    
    const expired = elapsedMinutes > DISCOUNT_MINUTES;
    const minutesLeft = Math.max(0, DISCOUNT_MINUTES - elapsedMinutes);
    
    return {
        expired: expired,
        minutesLeft: minutesLeft,
        elapsedMinutes: elapsedMinutes,
        qualifiedDate: attr.attribute_value,
        attrId: attr.id
    };
}

// ============ POPUP CHECK ENDPOINT (UPDATED) ============
app.get('/api/just-qualified/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    console.log(`🔍 Popup check for customer ${customerId}`);
    
    try {
        // Check if customer is in VIP group
        const customerUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?id:in=${customerId}`;
        const customerResponse = await axios.get(customerUrl, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const customer = customerResponse.data.data[0];
        const isInVIPGroup = customer && customer.customer_group_id === parseInt(VIP_GROUP_ID);
        
        if (!isInVIPGroup) {
            console.log(`   ❌ NOT in VIP group`);
            return res.json({ 
                justQualified: false,
                isVIP: false,
                minutesLeft: 0
            });
        }
        
        // Get qualification date and check expiry
        const expiry = await checkExpiry(customerId);
        
        // If no date attribute exists, treat as newly qualified
        if (!expiry.qualifiedDate) {
            console.log(`   ℹ️  No qualification date found, but customer is in VIP group`);
            console.log(`   🎉 Treating as newly qualified!`);
            
            // Set the current date as qualification date
            const today = new Date().toISOString();
            await setQualifiedDate(customerId, today);
            
            // Check popup flag
            const popupAttr = await getPopupAttribute(customerId);
            const showPopup = popupAttr?.attribute_value === 'true';
            
            if (showPopup) {
                console.log(`   🎉 SHOW POPUP - Just qualified!`);
                
                // Reset popup flag after showing
                // await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
                //     customer_id: customerId,
                //     attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
                //     value: 'false'
                // }], {
                //     headers: {
                //         'X-Auth-Token': BC_API_TOKEN,
                //         'Content-Type': 'application/json',
                //         'Accept': 'application/json'
                //     }
                // });
            }
            
            return res.json({ 
                justQualified: showPopup,
                isVIP: true,
                minutesLeft: DISCOUNT_MINUTES,
                discountPercent: DISCOUNT_PERCENT,
                qualifiedDate: today
            });
        }
        
        // Check if expired
        if (expiry.expired) {
            console.log(`   ⏰ VIP expired (${expiry.elapsedMinutes.toFixed(0)} minutes ago) - removing from group`);
            await removeFromVIPGroup(customerId);
            await deleteQualificationDate(customerId);
            return res.json({ 
                justQualified: false,
                isVIP: false,
                minutesLeft: 0
            });
        }
        
        // Check popup flag for qualified customers
        const popupAttr = await getPopupAttribute(customerId);
        const showPopup = popupAttr?.attribute_value === 'true';
        
        if (showPopup) {
            console.log(`   🎉 SHOW POPUP - Just qualified! (${expiry.minutesLeft.toFixed(0)} minutes left)`);
            
            // Reset popup flag after showing
            // await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
            //     customer_id: customerId,
            //     attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
            //     value: 'false'
            // }], {
            //     headers: {
            //         'X-Auth-Token': BC_API_TOKEN,
            //         'Content-Type': 'application/json',
            //         'Accept': 'application/json'
            //     }
            // });
        } else {
            console.log(`   ℹ️  Is VIP but popup flag not set (value: ${popupAttr?.attribute_value})`);
        }
        
        res.json({ 
            justQualified: showPopup,
            isVIP: true,
            minutesLeft: Math.floor(expiry.minutesLeft),
            discountPercent: DISCOUNT_PERCENT,
            qualifiedDate: expiry.qualifiedDate
        });
        
    } catch (error) {
        console.error(`   ❌ Error:`, error.message);
        res.json({ 
            justQualified: false,
            isVIP: false,
            minutesLeft: 0
        });
    }
});

// ============ EXPIRY CHECK (UPDATED FOR MINUTES) ============
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
            const qualifiedTime = new Date(attr.attribute_value).getTime();
            const elapsedMs = Date.now() - qualifiedTime;
            const elapsedMinutes = elapsedMs / (1000 * 60);
            
            if (elapsedMinutes > DISCOUNT_MINUTES) {
                console.log(`   ⏰ Customer ${attr.customer_id} expired (${elapsedMinutes.toFixed(0)} minutes ago)`);
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

// ============ WEBHOOK ENDPOINT (UPDATED) ============
app.post('/webhook', async (req, res) => {
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
        
        if (scope === 'store/order/created') {
            const orderId = data.id;
            console.log('📦 Order created:', orderId);
            
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
            
            const customerUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?id:in=${customerId}`;
            const customerResponse = await axios.get(customerUrl, { 
                headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
            });
            
            const customer = customerResponse.data.data[0];
            const isInVIPGroup = customer && customer.customer_group_id === parseInt(VIP_GROUP_ID);
            
            console.log(`   VIP status: ${isInVIPGroup}`);
            
            if (isInVIPGroup) {
                const expiry = await checkExpiry(customerId);
                
                if (expiry.expired) {
                    console.log(`   ⏰ VIP expired (${expiry.elapsedMinutes.toFixed(0)} minutes ago) - removing`);
                    await removeFromVIPGroup(customerId);
                    await deleteQualificationDate(customerId);
                } else {
                    console.log(`   ✅ VIP active (${expiry.minutesLeft.toFixed(0)} minutes left)\n`);
                }
                
                return res.sendStatus(200);
            }
            
            console.log('📦 Fetching products...');
            const productsUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v2/orders/${orderId}/products`;
            const productsResponse = await axios.get(productsUrl, { headers });
            const products = productsResponse.data;
            
            const totalQty = products.reduce((sum, p) => {
                console.log(`   - ${p.name}: qty ${p.quantity}`);
                return sum + p.quantity;
            }, 0);
            
            console.log(`   ✅ Total: ${totalQty}`);
            
            if (totalQty < MIN_QUANTITY) {
                console.log(`   ℹ️  Not qualifying (${totalQty} < ${MIN_QUANTITY})\n`);
                return res.sendStatus(200);
            }
            
            console.log(`   🎉 QUALIFIES!`);
            
            const today = new Date().toISOString();
            
            console.log(`\n🎊 QUALIFYING ${customerId}`);
            console.log(`   Start: ${today}`);
            console.log(`   Expires in: ${DISCOUNT_MINUTES} minutes`);
            
            const dateSuccess = await setQualifiedDate(customerId, today);
            const groupSuccess = await addToVIPGroup(customerId);
            
            if (dateSuccess && groupSuccess) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                const verifyDate = await checkIfQualified(customerId);
                
                if (verifyDate) {
                    console.log(`   ✅ CONFIRMED`);
                    
                    // Store popup trigger in BigCommerce attribute
                    if (process.env.POPUP_ATTRIBUTE_ID) {
                        await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
                            customer_id: customerId,
                            attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
                            value: 'true'
                        }], {
                            headers: {
                                'X-Auth-Token': BC_API_TOKEN,
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            }
                        });
                        console.log(`   🔔 Popup flag saved in attribute for customer ${customerId}`);
                    } else {
                        console.log(`   ⚠️  POPUP_ATTRIBUTE_ID not configured!`);
                    }
                    console.log('');
                } else {
                    console.log('   ⚠️  Could not verify\n');
                }
            } else {
                console.log('   ❌ Failed\n');
            }
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('   Status:', error.response.status);
        }
        res.sendStatus(500);
    }
});

// ============ HELPER FUNCTIONS (Keep all your existing helpers) ============
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

async function getPopupAttribute(customerId) {
    const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?customer_id:in=${customerId}`;
    try {
        const response = await axios.get(url, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        return response.data.data.find(av => 
            av.attribute_id === parseInt(process.env.POPUP_ATTRIBUTE_ID)
        ) || null;
    } catch (error) {
        console.error('Error getting popup attribute:', error.message);
        return null;
    }
}

async function checkIfQualified(customerId) {
    const attr = await getQualificationAttribute(customerId);
    return attr?.attribute_value || null;
}

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

// ============ CLEANUP ============
setInterval(() => {
    const expiry = Date.now() - 10 * 60 * 1000;
    for (const [id, ts] of recentlyQualified.entries()) {
        if (ts < expiry) {
            recentlyQualified.delete(id);
            console.log(`🧹 Cleaned up popup flag for customer ${id}`);
        }
    }
}, 60 * 1000);

// ============ RUN EXPIRY CHECK EVERY 30 SECONDS ============
checkExpiredVIPCustomers();
//setInterval(checkExpiredVIPCustomers, 30 * 1000); // Check every 30 seconds for 5-minute expiry
setInterval(checkExpiredVIPCustomers, 24 * 60 * 60 * 1000); // Check every day for expiry

// ============ ROOT ROUTE ============
app.get('/', (req, res) => res.send('VIP Wholesale Discount Server 🚀'));

// ============ DEBUG ENDPOINTS ============
app.post('/api/trigger-expiry-check', async (req, res) => {
    await checkExpiredVIPCustomers();
    res.json({ status: 'done' });
});

app.get('/api/check-customer/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    try {
        const attrUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values?customer_id:in=${customerId}`;
        const attrResponse = await axios.get(attrUrl, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const customerUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?id:in=${customerId}`;
        const customerResponse = await axios.get(customerUrl, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const customer = customerResponse.data.data[0];
        
        res.json({
            customerId: customerId,
            customerGroupId: customer?.customer_group_id,
            expectedVIPGroupId: parseInt(VIP_GROUP_ID),
            isInVIPGroup: customer?.customer_group_id === parseInt(VIP_GROUP_ID),
            attributes: attrResponse.data.data,
            popupAttributeId: parseInt(process.env.POPUP_ATTRIBUTE_ID),
            dateAttributeId: parseInt(DATE_ATTRIBUTE_ID),
            popupFlagValue: attrResponse.data.data.find(a => a.attribute_id === parseInt(process.env.POPUP_ATTRIBUTE_ID))?.attribute_value,
            dateAttributeValue: attrResponse.data.data.find(a => a.attribute_id === parseInt(DATE_ATTRIBUTE_ID))?.attribute_value,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/trigger-popup/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    if (!process.env.POPUP_ATTRIBUTE_ID) {
        return res.status(400).json({ error: 'POPUP_ATTRIBUTE_ID not configured' });
    }
    
    try {
        await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
            customer_id: customerId,
            attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
            value: 'true'
        }], {
            headers: {
                'X-Auth-Token': BC_API_TOKEN,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
        
        res.json({ 
            success: true, 
            message: `Popup flag set to 'true' for customer ${customerId}`,
            popupAttributeId: parseInt(process.env.POPUP_ATTRIBUTE_ID)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/fix-missing-popups', async (req, res) => {
    try {
        const customersUrl = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers?customer_group_id:in=${VIP_GROUP_ID}`;
        const customersResponse = await axios.get(customersUrl, { 
            headers: { 'X-Auth-Token': BC_API_TOKEN, 'Accept': 'application/json' }
        });
        
        const vipCustomers = customersResponse.data.data;
        console.log(`Found ${vipCustomers.length} VIP customers`);
        
        let fixed = 0;
        for (const customer of vipCustomers) {
            const popupAttr = await getPopupAttribute(customer.id);
            
            if (!popupAttr || popupAttr.attribute_value !== 'true') {
                await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
                    customer_id: customer.id,
                    attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
                    value: 'true'
                }], {
                    headers: {
                        'X-Auth-Token': BC_API_TOKEN,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    }
                });
                fixed++;
                console.log(`   ✅ Set popup flag for customer ${customer.id}`);
            }
        }
        res.json({ 
            success: true, 
            message: `Set popup flag for ${fixed} customers`,
            totalVIP: vipCustomers.length,
            fixed: fixed
        });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Add this to server.js to debug expiry
app.get('/api/debug-expiry/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    try {
        const attr = await getQualificationAttribute(customerId);
        if (!attr) {
            return res.json({ error: 'No qualification date found' });
        }
        
        const qualifiedTime = new Date(attr.attribute_value).getTime();
        const currentTime = Date.now();
        const elapsedMs = currentTime - qualifiedTime;
        const elapsedMinutes = elapsedMs / (1000 * 60);
        
        res.json({
            customerId: customerId,
            qualifiedDate: attr.attribute_value,
            qualifiedTimestamp: qualifiedTime,
            currentTimestamp: currentTime,
            elapsedMinutes: elapsedMinutes,
            discountMinutes: DISCOUNT_MINUTES,
            shouldBeExpired: elapsedMinutes > DISCOUNT_MINUTES,
            minutesUntilExpiry: Math.max(0, DISCOUNT_MINUTES - elapsedMinutes)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Manual endpoint to add ANY customer to VIP with ALL attributes
app.post('/api/manual-vip/:customerId', async (req, res) => {
    const customerId = parseInt(req.params.customerId);
    
    if (!customerId || isNaN(customerId)) {
        return res.status(400).json({ error: 'Invalid customer ID' });
    }
    
    try {
        const today = new Date().toISOString();
        
        // 1. Set qualification date (attribute ID 1)
        await setQualifiedDate(customerId, today);
        
        // 2. Add to VIP group
        await addToVIPGroup(customerId);
        
        // 3. Set popup flag (attribute ID 2)
        if (process.env.POPUP_ATTRIBUTE_ID) {
            await axios.put(`https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attribute-values`, [{
                customer_id: customerId,
                attribute_id: parseInt(process.env.POPUP_ATTRIBUTE_ID),
                value: 'true'
            }], {
                headers: {
                    'X-Auth-Token': BC_API_TOKEN,
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            });
        }
        
        // 4. Verify everything was set
        const verifyDate = await getQualificationAttribute(customerId);
        const verifyPopup = await getPopupAttribute(customerId);
        
        console.log(`✅ Manually added customer ${customerId} to VIP`);
        console.log(`   Qualification date: ${verifyDate?.attribute_value}`);
        console.log(`   Popup flag: ${verifyPopup?.attribute_value}`);
        
        res.json({ 
            success: true, 
            message: `Customer ${customerId} manually added to VIP`,
            qualificationDate: verifyDate?.attribute_value,
            popupFlag: verifyPopup?.attribute_value,
            expiresIn: `${DISCOUNT_MINUTES} minutes`
        });
        
    } catch (error) {
        console.error('Error in manual-vip:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log('   Health:  /health');
    console.log('   Webhook: /webhook');
    console.log('   VIP Info: /api/vip-info');
    console.log('   Popup: /api/just-qualified/:customerId\n');
});