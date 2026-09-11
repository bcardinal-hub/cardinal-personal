// Transactional email via Resend's REST API — same "plain fetch, no SDK"
// pattern as lib/plaid.js and lib/stripe.js. Used for password reset and
// the email sign-in code (consumer MFA, see routes/auth.js).
import fetch from "node-fetch";

// EMAIL_FROM should be an address on a domain verified in Resend. The
// fallback, Resend's shared onboarding@resend.dev sender, only delivers to
// the Resend account owner's own address — anyone else gets a 403 ("You can
// only send testing emails to your own email address"). So until EMAIL_FROM
// is on a verified domain, password-reset emails reach only the owner, and
// REQUIRE_LOGIN_CODE must stay off or every other user is locked out.
const FROM = process.env.EMAIL_FROM || "Cardinal Finance AI <onboarding@resend.dev>";

async function sendEmail({ to, subject, text, html }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("Email isn't configured yet (RESEND_API_KEY missing).");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Resend request failed (${response.status})${errText ? `: ${errText.slice(0, 300)}` : ""}`);
  }
}

export async function sendPasswordResetEmail(toEmail, resetUrl) {
  return sendEmail({
    to: toEmail,
    subject: "Reset your Cardinal Finance AI password",
    text: `Someone (hopefully you) requested a password reset for your Cardinal Finance AI account.\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password hasn't been changed.`,
    html: `<p>Someone (hopefully you) requested a password reset for your Cardinal Finance AI account.</p><p><a href="${resetUrl}">Reset your password</a></p><p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password hasn't been changed.</p>`,
  });
}

// The code goes in the subject so it's readable straight from a phone
// notification without opening the email.
export async function sendLoginCodeEmail(toEmail, code) {
  return sendEmail({
    to: toEmail,
    subject: `${code} is your Cardinal Finance AI sign-in code`,
    text: `Your Cardinal Finance AI sign-in code is ${code}\n\nIt expires in 10 minutes and works once.\n\nIf you didn't just try to sign in, someone may know your password — reset it from the sign-in page.`,
    html: `<p>Your Cardinal Finance AI sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>It expires in 10 minutes and works once.</p><p>If you didn't just try to sign in, someone may know your password — reset it from the sign-in page.</p>`,
  });
}
