// Secrets must never leave the tool (Slack alerts, summaries). Customers
// sometimes paste passwords or card numbers into messages.
export function redactSecrets(text = '') {
  return String(text)
    // "password: x", "password is x", "password is: x", "mot de passe est x"
    .replace(/\b(password|passwd|pwd|mot de passe|mdp|passwort|contrase(?:ñ|n)a|senha)((?:\s+(?:is|est|ist|es|é))?\s*[:=]\s*|\s+(?:is|est|ist|es|é)\s+)\S+/gi, '$1$2[redacted]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card number redacted]')
    .replace(/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, '[API key redacted]');
}
