import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// ✅ Usando 'function' tradicional para garantir o hoisting no escopo do arquivo
function formatarData(data: string): string {
  const d = new Date(data);
  return isNaN(d.getTime()) ? data : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ⚡ A MÁGICA ESTÁ NA ÚLTIMA LINHA DESTE BLOCO (as any)
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: Number(process.env.EMAIL_PORT) || 587, // Garante 587 se a env falhar
  secure: false, // TLS/STARTTLS para porta 587
  
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },

  // 🔌 FORÇA O NODEMAILER A USAR IPV4 (Resolve o erro ENETUNREACH)
  family: 4, 

  requireTLS: true, 

  tls: {
    rejectUnauthorized: false 
  },

  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 30000,
} as any); // <--- ISTO FAZ A LINHA VERMELHA DO 'host' SUMIR NA HORA

export async function enviarEmailConfirmacaoCliente(ensaio: any) {
  // 💻 Em desenvolvimento (mude para /api):
  const linkCancelamento = `http://localhost:3000/api/v1/agendamentos/cancelar?id=${ensaio.id}&token=${ensaio.token_cancelamento}`;

  // 🚀 PRODUÇÃO (Quando subir o backend para a HostGator/VPS, desinale esta linha e comente a de cima):
  // const linkCancelamento = `https://api.suaagencia.com.br/v1/agendamentos/cancelar?id=${ensaio.id}&token=${ensaio.token_cancelamento}`;

  const mailOptions = {
    from: `"Arsenal Estratégia" <${process.env.EMAIL_USER}>`,
    to: ensaio.email_cliente,
    subject: '📆 Agendamento Confirmado - Arsenal Estratégia',
    html: `
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
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 E-mail de confirmação enviado para: ${ensaio.email_cliente}`);
  } catch (error) {
    console.error('❌ Erro ao enviar e-mail para o cliente:', error);
  }
}

export async function notificarColaboradorAtribuido(colaborador: any, ensaio: any) {
  const mailOptions = {
    from: `"Arsenal Interno" <${process.env.EMAIL_USER}>`,
    to: colaborador.email,
    subject: '🎥 Nova Escalação: ' + ensaio.empresa_nome,
    html: `
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
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`📧 Colaborador ${colaborador.nome} notificado.`);
    
    const mensagemWhats = `Fala ${colaborador.nome}! Você foi escalado na equipe da ${ensaio.empresa_nome} no dia ${formatarData(ensaio.data_ensaio)} às ${ensaio.hora_inicio}.`;
    return `https://api.whatsapp.com/send?phone=${colaborador.telefone}&text=${encodeURIComponent(mensagemWhats)}`;
  } catch (error) {
    console.error('❌ Erro ao notificar colaborador:', error);
  }
}

// 🛠️ Nova função interna para avisar a equipe que a agenda caiu
export async function enviarEmailCancelamentoInterno(colaborador: any, ensaio: any) {
  const mailOptions = {
    from: `"Arsenal Interno" <${process.env.EMAIL_USER}>`,
    to: colaborador.email,
    subject: '⚠️ CANCELADO: Ensaio - ' + ensaio.empresa_nome,
    html: `
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
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`⚠️ Alerta de cancelamento enviado para o colaborador: ${colaborador.email}`);
  } catch (error) {
    console.error('❌ Erro ao disparar e-mail de cancelamento para equipe:', error);
  }
}