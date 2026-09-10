// Transactional email via Resend's REST API — same "plain fetch, no SDK"
// pattern as lib/plaid.js and lib/stripe.js. Used only for password reset
// right now; kept generic enough to reuse for other transactional email
// later (e.g. a welcome email) without restructuring.
import fetch from "node-fetch";

// Resend's shared sandbox sender — works immediately with no domain setup,
// which matters because this app doesn't have a custom domain to send
// "from" yet. Swap to a verified address on a real domain once one exists;
// deliverability is meaningfully better than a shared sandbox sender.
const FROM = "Cardinal Finance AI <onboarding@resend.dev>";

export async function sendPasswordResetEmail(toEmail, resetUrl) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Email isn't configured yet (RESEND_API_KEY missing).");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [toEmail],
      subject: "Reset your Cardinal Finance AI password",
      text: `Someone (hopefully you) requested a password reset for your Cardinal Finance AI account.\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password hasn't been changed.`,
      html: `<p>Someone (hopefully you) requested a password reset for your Cardinal Finance AI account.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password hasn't been changed.</p>`,
    }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend request failed (${response.status})${errText ? `: ${errText.slice(0, 300)}` : ""}`);
  }
}
