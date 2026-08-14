'use strict';

/**
 * database.js
 * -----------------------------------------------------------------------------
 * Connection factories for MySQL and MongoDB.
 */

const mysql = require('mysql2/promise');
const { MongoClient } = require('mongodb');

// ---------------------------------------------------------------------------
// Environment configuration (with defaults for local runs)
// ---------------------------------------------------------------------------
const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || 'mysql-db',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || 'labpassword',
  database: process.env.MYSQL_DATABASE || 'capacity_lab',

  // Sized from measured service time: with connectionLimit=2 the plateau
  // throughput was ~449 req/s -> W = 2/449 ~= 4.5ms per query. MySQL's
  // max_connections is 151 and queries here are sub-10ms, so 20 connections
  // gives headroom for ~4400 req/s before queueing (20/0.0045) while leaving
  // most of max_connections free for other clients/replicas.
  // queueLimit is bounded (not 0/unlimited) so a burst past capacity fails
  // fast with a queue-limit error instead of piling up into multi-second
  // waits — degrade gracefully rather than freeze.
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 200,
  connectTimeout: 10_000,
  maxIdle: 20,
  idleTimeout: 60_000,
  enableKeepAlive: true,
};

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo-db:27017';
const MONGO_DB_NAME = process.env.MONGO_DB || 'capacity_lab';

// ---------------------------------------------------------------------------
// MySQL pool (singleton)
// ---------------------------------------------------------------------------
let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool(MYSQL_CONFIG);
  }
  return pool;
}

// ---------------------------------------------------------------------------
// MongoDB client (singleton, lazily connected)
// ---------------------------------------------------------------------------
let mongoClient;
let mongoDb;

async function getMongo() {
  if (!mongoDb) {
    mongoClient = new MongoClient(MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5_000,
    });
    await mongoClient.connect();
    mongoDb = mongoClient.db(MONGO_DB_NAME);
  }
  return mongoDb;
}

// ---------------------------------------------------------------------------
// Graceful shutdown helpers
// ---------------------------------------------------------------------------
async function closeAll() {
  if (pool) {
    try { await pool.end(); } catch (_) { /* ignore */ }
    pool = undefined;
  }
  if (mongoClient) {
    try { await mongoClient.close(); } catch (_) { /* ignore */ }
    mongoClient = undefined;
    mongoDb = undefined;
  }
}

module.exports = {
  MYSQL_CONFIG,
  MONGO_URI,
  MONGO_DB_NAME,
  getPool,
  getMongo,
  closeAll,
};
