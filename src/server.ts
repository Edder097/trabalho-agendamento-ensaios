import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { router } from './routes.js'; // ✅ Ajustado para importação nomeada com chaves

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Guardião para ler o formulário de motivo

// Usar as rotas da agenda
app.use('/api', router);

app.get('/', (req, res) => {
  res.json({ message: "API da Arsenal Estratégia rodando com sucesso! 🚀" });
});

app.listen(PORT, () => {
  console.log(`⚡ Servidor rodando na porta http://localhost:${PORT}`);
});