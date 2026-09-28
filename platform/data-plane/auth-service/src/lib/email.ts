import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { redis } from './redis.js';

let transporter: nodemailer.Transporter | null = null;
if (config.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER && config.SMTP_PASSWORD ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
  });
}

export interface OutgoingEmail {
  projectId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  meta?: Record<string, string>;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function sendEmail(mail: OutgoingEmail) {
  if (config.AUTH_DEV_MAILBOX) {
    const key = `auth:dev-mailbox:${mail.projectId}:${mail.to.toLowerCase()}`;
    await redis.lpush(key, JSON.stringify({ ...mail, sent_at: new Date().toISOString() }));
    await redis.ltrim(key, 0, 19);
    await redis.expire(key, 3600);
  }
  if (transporter) {
    await transporter.sendMail({ from: config.SMTP_FROM || 'no-reply@owndatabase.local', to: mail.to, subject: mail.subject, html: mail.html, text: mail.text });
  } else if (!config.AUTH_DEV_MAILBOX) {
    console.log(`[email:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}

function layout(title: string, body: string) {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
<h2 style="margin-top:0">${escape(title)}</h2>${body}
<p style="color:#6b7280;font-size:12px">If you did not request this, you can ignore this email.</p></div>`;
}

export async function sendVerificationEmail(projectId: string, email: string, code: string, link: string) {
  await sendEmail({
    projectId, to: email, subject: 'Confirm your email',
    text: `Your confirmation code is ${code}\nOr open: ${link}`,
    html: layout('Confirm your email', `<p>Your code: <strong style="font-size:20px;letter-spacing:3px">${code}</strong></p><p><a href="${escape(link)}">Confirm email</a></p>`),
    meta: { type: 'signup', code },
  });
}

export async function sendPasswordResetEmail(projectId: string, email: string, code: string, link: string) {
  await sendEmail({
    projectId, to: email, subject: 'Reset your password',
    text: `Your password reset code is ${code}\nOr open: ${link}`,
    html: layout('Reset your password', `<p>Your code: <strong style="font-size:20px;letter-spacing:3px">${code}</strong></p><p><a href="${escape(link)}">Choose a new password</a></p>`),
    meta: { type: 'recovery', code },
  });
}

export async function sendMagicLinkEmail(projectId: string, email: string, code: string, link: string) {
  await sendEmail({
    projectId, to: email, subject: 'Your sign-in link',
    text: `Your sign-in code is ${code}\nOr open: ${link}`,
    html: layout('Sign in', `<p>Your code: <strong style="font-size:20px;letter-spacing:3px">${code}</strong></p><p><a href="${escape(link)}">Sign in</a></p>`),
    meta: { type: 'magiclink', code },
  });
}
