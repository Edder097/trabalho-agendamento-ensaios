import dotenv from 'dotenv';

dotenv.config();

// ✅ URL do seu Webhook no n8n (Coloque a URL correta aqui ou no seu .env)
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_EMAIL || 'https://n8n-new.arsenalestrategia.com.br/webhook/agends-foto';

// Função auxiliar nativa para enviar o payload para o n8n
async function dispararParaN8n(evento: string, to: string, subject: string, html: string, dadosExtras: any = {}) {
  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        evento,        // Ex: 'confirmacao_cliente', 'nova_escalacao'
        to,            // Quem vai receber o e-mail
        subject,       // Assunto do e-mail
        html,          // O corpo do e-mail montado
        ...dadosExtras // Dados adicionais (como telefone do whatsapp, etc)
      }),
    });

    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
  } catch (error) {
    console.error(`❌ Erro ao enviar evento '${evento}' para o n8n:`, error);
  }
}

function formatarData(data: string): string {
  const d = new Date(data);
  return isNaN(d.getTime()) ? data : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export async function enviarEmailConfirmacaoCliente(ensaio: any) {
  const linkCancelamento = `http://localhost:3000/api/v1/agendamentos/cancelar?id=${ensaio.id}&token=${ensaio.token_cancelamento}`;

  // 1. Extração direta da string YYYY-MM-DD para evitar conversão de fuso do objeto Date
  const [ano, mes, dia] = ensaio.data_ensaio.split('-');
  
  // 2. Formatação segura dos horários (garantindo segundos)
  const inicio = ensaio.hora_inicio.length === 5 ? `${ensaio.hora_inicio}:00` : ensaio.hora_inicio;
  const fim = ensaio.hora_fim.length === 5 ? `${ensaio.hora_fim}:00` : ensaio.hora_fim;

  // 3. Montagem manual da string ISO com o offset -03:00 fixo
  // Isso impede que o JS converta para Z (UTC)
  const startTime = `${ano}-${mes}-${dia}T${inicio}.000-03:00`;
  const endTime = `${ano}-${mes}-${dia}T${fim}.000-03:00`;

  const htmlContent = `...`; // (Seu HTML permanece igual)

  await dispararParaN8n(
    'confirmacao_cliente',
    ensaio.email_cliente,
    '📆 Agendamento Confirmado - Arsenal Estratégia',
    htmlContent,
    { 
      google_calendar: {
        start: startTime,
        end: endTime
      }
    }
  );
  
  console.log(`🚀 Payload enviado com formato de data fixo: ${startTime}`);
}

export async function notificarColaboradorAtribuido(colaborador: any, ensaio: any) {
  const htmlContent = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #0f172a; color: #f1f5f9; padding: 30px; border-radius: 12px; max-width: 500px; border: 1px solid #334155; margin: 0 auto;">
      <h2 style="color: #3b82f6; margin-top: 0;">Fala, ${colaborador.nome}! 🎬</h2>
      <p>Você foi escalado para um novo ensaio:</p>
      
      <div style="background-color: #1e293b; padding: 15px; border-radius: 8px;">
        <p style="margin: 5px 0;"><strong>Cliente:</strong> ${ensaio.empresa_nome}</p>
        <p style="margin: 5px 0;"><strong>Data:</strong> ${formatarData(ensaio.data_ensaio)}</p>
        <p style="margin: 5px 0;"><strong>Horário:</strong> ${ensaio.hora_inicio} até ${ensaio.hora_fim}</p>
        <p style="margin: 5px 0;"><strong>Função:</strong> ${colaborador.funcao}</p>
      </div>
      
      <p style="margin-top: 20px;"><strong>Objetivos:</strong><br/>${ensaio.objetivos}</p>
    </div>
  `;

  const mensagemWhats = `Fala ${colaborador.nome}! Você foi escalado na equipe da ${ensaio.empresa_nome} no dia ${formatarData(ensaio.data_ensaio)} às ${ensaio.hora_inicio}.`;

  await dispararParaN8n(
    'notificacao_colaborador',
    colaborador.email,
    '🎥 Nova Escalação: ' + ensaio.empresa_nome,
    htmlContent,
    { telefone_whatsapp: colaborador.telefone, mensagem_whatsapp: mensagemWhats } // Passando dados do whats para o n8n aproveitar
  );

  console.log(`🚀 Payload de colaborador enviado para o n8n (${colaborador.nome}).`);
  
  // Mantive o seu return original para não quebrar a lógica em outras partes do seu sistema
  return `https://api.whatsapp.com/send?phone=${colaborador.telefone}&text=${encodeURIComponent(mensagemWhats)}`;
}

export async function enviarEmailCancelamentoInterno(colaborador: any, ensaio: any) {
  const htmlContent = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #0f172a; color: #f1f5f9; padding: 30px; border-radius: 12px; max-width: 500px; border: 1px solid #ef4444; margin: 0 auto;">
      <h2 style="color: #ef4444; margin-top: 0;">Atenção, ${colaborador.nome}! ⚠️</h2>
      <p>O ensaio abaixo que estava sob sua responsabilidade foi <strong>CANCELADO</strong> pelo cliente:</p>
      
      <div style="background-color: #1e293b; padding: 15px; border-radius: 8px; border-left: 4px solid #ef4444;">
        <p style="margin: 5px 0;"><strong>Cliente:</strong> ${ensaio.empresa_nome}</p>
        <p style="margin: 5px 0;"><strong>Data que seria:</strong> ${formatarData(ensaio.data_ensaio)}</p>
        <p style="margin: 5px 0;"><strong>Sua Função na Escala:</strong> ${colaborador.funcao}</p>
      </div>
      
      <p style="margin-top: 20px; font-size: 13px; color: #94a3b8;">O horário correspondente já foi liberado no banco de dados da plataforma.</p>
    </div>
  `;

  await dispararParaN8n(
    'cancelamento_interno',
    colaborador.email,
    '⚠️ CANCELADO: Ensaio - ' + ensaio.empresa_nome,
    htmlContent
  );

  console.log(`🚀 Payload de cancelamento enviado para o n8n (${colaborador.email})`);
}