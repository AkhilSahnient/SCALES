require('dotenv').config();
const axios = require('axios');

const BC_STORE_HASH = process.env.BC_STORE_HASH;
const BC_API_TOKEN = process.env.BC_API_TOKEN;

async function createAttributes() {
  const url = `https://api.bigcommerce.com/stores/${BC_STORE_HASH}/v3/customers/attributes`;
  const headers = {
    'X-Auth-Token': BC_API_TOKEN,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  // ⚠️  CRITICAL: DO NOT INCLUDE attribute_id. Only these 4 keys.
  const payload = [
    {
      name: 'wholesale_offer_qualified_date',
      display_name: 'Wholesale Offer Qualified Date',
      type: 'date',
      resource: 'global'
    }
  ];

  console.log('Sending payload:', JSON.stringify(payload, null, 2));

  try {
    const response = await axios.put(url, payload, { headers });
    console.log('✅ SUCCESS!');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    const attrId = response.data.data[0]?.id;
    if (attrId) {
      console.log(`\n📌 Add this to your .env: DATE_ATTRIBUTE_ID=${attrId}`);
    }
  } catch (error) {
    console.error('❌ FAILED:');
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
  }
}

createAttributes();