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
  // 💻 Em desenvolvimento (mude para /api):
  const linkCancelamento = `http://localhost:3000/api/v1/agendamentos/cancelar?id=${ensaio.id}&token=${ensaio.token_cancelamento}`;

  // Cálculo das datas para o Google Calendar
  const dataBanco = new Date(ensaio.data_ensaio);
  const ano = dataBanco.getUTCFullYear();
  const mes = String(dataBanco.getUTCMonth() + 1).padStart(2, '0');
  const dia = String(dataBanco.getUTCDate()).padStart(2, '0');
  const dataFormatadaISO = `${ano}-${mes}-${dia}`;
  
  // Garantindo o formato HH:mm:ss
  const inicioComSegundos = ensaio.hora_inicio.length === 5 ? `${ensaio.hora_inicio}:00` : ensaio.hora_inicio;
  const fimComSegundos = ensaio.hora_fim.length === 5 ? `${ensaio.hora_fim}:00` : ensaio.hora_fim;

  const htmlContent = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; background-color: #0f172a; color: #f1f5f9; padding: 30px; border-radius: 12px; max-width: 500px; border: 1px solid #1e293b; margin: 0 auto;">
      <h2 style="color: #ef4444; margin-top: 0; border-bottom: 2px solid #ef4444; padding-bottom: 10px;">Arsenal Estratégia 🔥</h2>
      <p style="font-size: 16px;">Olá! Seu ensaio foi agendado com sucesso.</p>
      
      <div style="background-color: #1e293b; padding: 15px; border-radius: 8px; margin: 20px 0;">
        <p style="margin: 5px 0;"><strong>🏢 Empresa:</strong> ${ensaio.empresa_nome}</p>
        <p style="margin: 5px 0;"><strong>📅 Data:</strong> ${formatarData(ensaio.data_ensaio)}</p>
        <p style="margin: 5px 0;"><strong>⏰ Horário:</strong> ${ensaio.hora_inicio}</p>
      </div>
      
      <p style="color: #94a3b8; font-size: 14px;">Em breve entraremos em contato para o alinhamento do roteiro. Fique atento!</p>
      
      <hr style="border: 0; border-top: 1px solid #334155; margin: 20px 0;" />
      
      <p style="font-size: 12px; color: #64748b;">Precisou mudar de ideia ou quer cancelar o agendamento? Clique no link abaixo:</p>
      <p style="margin: 10px 0;"><a href="${linkCancelamento}" style="color: #ef4444; font-size: 13px; text-decoration: underline; font-weight: bold;">Clique aqui para cancelar este agendamento</a></p>
      
      <p style="margin-top: 30px; font-weight: bold; color: #ef4444;">Equipe Arsenal 🚀</p>
    </div>
  `;

await dispararParaN8n(
  'confirmacao_cliente',
  ensaio.email_cliente,
  '📆 Agendamento Confirmado - Arsenal Estratégia',
  htmlContent,
  { 
    contato_telefone: ensaio.contato_telefone,
    empresa_nome: ensaio.empresa_nome,
    contato_nome: ensaio.contato_nome,
    data_formatada: formatarData(ensaio.data_ensaio),
    hora_inicio_formatada: ensaio.hora_inicio.substring(0, 5),
    hora_fim_formatada: ensaio.hora_fim.substring(0, 5),
    objetivos: ensaio.objetivos,
    id_ensaio: ensaio.id,
    google_calendar: {
      start: `${dataFormatadaISO}T${inicioComSegundos}-03:00`,
      end: `${dataFormatadaISO}T${fimComSegundos}-03:00`
    }
  }
);
  
    console.log(`🚀 Payload de confirmação + Calendar enviado para o n8n (Destino: ${ensaio.email_cliente})`);
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