require('dotenv').config();
const axios = require('axios');

const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_API_TOKEN = process.env.BC_API_TOKEN;

// Use your live ngrok URL + /webhook
const DESTINATION = 'https://prerepublican-harmless-latasha.ngrok-free.dev'; 

async function createWebhook(scope) {
  const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/hooks`;
  const headers = {
    'X-Auth-Token': BC_API_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  const payload = {
    scope,
    destination: DESTINATION,
    is_active: true,
    headers: {}
  };

  try {
    const res = await axios.post(url, payload, { headers });
    console.log(`✅ ${scope} webhook created`);
    console.log(`   ID: ${res.data.data.id}`);
    console.log(`   🔑 Secret: ${res.data.data.secret}`);
    return res.data.data.secret;
  } catch (err) {
    console.error(`❌ ${scope}:`, err.response?.data || err.message);
  }
}

async function setup() {
  await createWebhook('store/order/created');
  await createWebhook('store/cart/updated');
}

setup();