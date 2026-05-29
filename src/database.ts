import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

export const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
});

// Testar a conexão assim que o app iniciar
pool.connect((err, client, release) => {
  if (err) {
    return console.error('❌ Erro ao conectar no banco de dados:', err.stack);
  }
  console.log('🚀 Conexão com o PostgreSQL estabelecida com sucesso!');
  release();
});