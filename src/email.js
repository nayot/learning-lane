const { google } = require("googleapis");

const adminEmail = process.env.FAMILY_APPROVAL_EMAIL || "nayot@eng.buu.ac.th";

function isGmailConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN &&
    process.env.APP_BASE_URL
  );
}

async function sendFamilyApprovalEmail({ to = adminEmail, requester, familyName, kidName, approvalUrl, expiresAt }) {
  if (!isGmailConfigured()) {
    throw new Error("Gmail approval email is not configured. Set APP_BASE_URL and GMAIL_REFRESH_TOKEN.");
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });
  const sender = process.env.GMAIL_SENDER_EMAIL || adminEmail;
  const subject = `Learning Lane family approval: ${familyName}`;
  const text = [
    "A new Learning Lane family is waiting for approval.",
    "",
    `Family: ${familyName}`,
    `First kid: ${kidName}`,
    `Requester: ${requester.name} <${requester.email}>`,
    `Expires: ${expiresAt}`,
    "",
    "Approve this family:",
    approvalUrl,
    "",
    "If you did not expect this request, ignore this email."
  ].join("\n");

  const raw = [
    `From: Learning Lane <${sender}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text
  ].join("\r\n");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: Buffer.from(raw).toString("base64url")
    }
  });
}

module.exports = {
  adminEmail,
  isGmailConfigured,
  sendFamilyApprovalEmail
};
