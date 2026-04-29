const { CosmosClient } = require('@azure/cosmos');
require('dotenv').config();

const client = new CosmosClient({
  endpoint: process.env.COSMOS_URI,
  key: process.env.COSMOS_KEY,
});

const database = client.database(process.env.DATABASE_NAME);
const container = database.container(process.env.CONTAINER_NAME);

module.exports = container;
