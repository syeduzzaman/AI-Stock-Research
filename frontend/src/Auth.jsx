import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChartNoAxesCombined, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { request } from "./api.js";
import { useLanguage } from "./language.jsx";
import { Notice } from "./ui.jsx";

const copy = {
  login: ["Sign in", "Your watchlist, holdings, and analyses are saved to your account.", "Sign in"],
  signup: ["Create your account", "Your watchlist, holdings, and analyses are saved to your account.", "Create account"],
  verify: ["Check your email", "Enter the verification code from your email.", "Verify code"],
  link: ["Check your email", "Open the email from Supabase Auth and select Confirm your email. Then sign in to AI Stock Research.", "Back to sign in"],
  recover: ["Reset your password", "Enter the email address you use to sign in.", "Send reset code"],
  reset: ["Choose a new password", "Enter the reset code from your email and a new password with at least 12 characters.", "Save new password"],
  demo: ["Open the demo workspace", "Try the research flow with synthetic prices and sample filing excerpts.", "Open demo"],
};

export function Auth({ config, onSignIn, initialNotice }) {
  const { t } = useLanguage();
  const [mode, setMode] = useState(config.hosted ? "login" : "demo");
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState(initialNotice);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const emailInput = useRef(null);
  const codeInput = useRef(null);
  const passwordInput = useRef(null);
  const followLink = mode === "verify" && config.confirmationMode !== "code";
  const codeRequired = (mode === "verify" && !followLink) || mode === "reset";
  const newPassword = mode === "signup" || mode === "reset";
  const [title, description, submit] = copy[followLink ? "link" : mode];

  useEffect(() => {
    if (codeRequired) codeInput.current?.focus();
    if (mode === "recover") emailInput.current?.focus();
  }, [codeRequired, mode]);

  function changeMode(next) {
    setShowPassword(false);
    setMode(next);
    setNotice(null);
  }

  async function send(action, fields) {
    setBusy(true);
    setNotice(null);
    setShowPassword(false);
    try {
      const input = { action, email: email.trim() };
      for (const field of ["username", "password", "code"]) {
        if (fields?.has(field)) input[field] = fields.get(field);
      }
      const data = await request("/api/account", { method: "POST", input });
      if (passwordInput.current) passwordInput.current.value = "";
      if (codeInput.current) codeInput.current.value = "";
      if (data.signedIn) await onSignIn();
      else if (data.passwordReset) {
        setMode("login");
        setNotice({ message: "Password updated. Sign in with your new password." });
      } else if (data.recoveryRequested) {
        setMode("reset");
        setNotice({ message: "If an account exists for that email, a reset code has been sent." });
      } else if (data.verificationRequired) {
        setMode("verify");
        if (action === "resend") setNotice({ message: data.message });
      }
    } catch (error) {
      setNotice({ message: error.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (followLink) return changeMode("login");
    void send(mode, new FormData(event.currentTarget));
  }

  const Icon = config.hosted ? LockKeyhole : ChartNoAxesCombined;
  return <section className="card sign-in" aria-labelledby="account-title">
    <span className="account-mark" aria-hidden="true"><Icon size={22} /></span>
    <h2 id="account-title">{t(title)}</h2>
    <p>{t(mode === "demo" && config.marketMode !== "demo" ? "Open a local workspace to research your stocks." : description)}</p>
    <form onSubmit={handleSubmit} noValidate={followLink}>
      {mode === "signup" && <>
        <label htmlFor="username">{t("Username")}</label>
        <input id="username" name="username" autoComplete="username" minLength={3} maxLength={24} required
          pattern="[a-zA-Z0-9_]{3,24}" title={t("3–24 letters, numbers, or underscores")} />
      </>}
      {config.hosted && <>
        <label htmlFor="email">{t("Email")}</label>
        <input id="email" name="email" ref={emailInput} type="email" value={email} onChange={event => setEmail(event.target.value)}
          autoComplete={mode === "login" ? "username" : "email"} maxLength={254} required />
      </>}
      {(mode === "login" || newPassword) && <>
        <label htmlFor="password">{t(mode === "reset" ? "New password" : "Password")}</label>
        <div className="password-field">
          <input key={mode} id="password" name="password" type={showPassword ? "text" : "password"} ref={passwordInput}
            autoComplete={newPassword ? "new-password" : "current-password"} minLength={newPassword ? 12 : 8} maxLength={256} required />
          <button className="password-visibility" type="button" disabled={busy}
            aria-label={t(showPassword ? "Hide password" : "Show password")} onClick={() => setShowPassword(value => !value)}>
            {showPassword ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
          </button>
        </div>
      </>}
      {codeRequired && <>
        <label htmlFor="email-code">{t("Verification code")}</label>
        <input id="email-code" name="code" ref={codeInput} autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,10}" maxLength={10} required />
      </>}
      <Notice notice={notice} />
      <div className="account-actions">
        <button className="primary account-submit" disabled={busy} type="submit" aria-busy={busy}>
          {t(busy ? "Loading…" : submit)} <ArrowRight size={17} aria-hidden="true" />
        </button>
        {config.hosted && !followLink && <button className="text-button" type="button" disabled={busy}
          onClick={() => changeMode(mode === "login" ? "signup" : "login")}>
          {t(mode === "login" ? "Create account" : "Back to sign in")}
        </button>}
        {mode === "login" && config.passwordRecovery && <button className="text-button" type="button" disabled={busy}
          onClick={() => changeMode("recover")}>{t("Forgot password?")}</button>}
        {["verify", "reset"].includes(mode) && <button className="text-button" type="button" disabled={busy} onClick={() => {
          if (emailInput.current.reportValidity()) void send(mode === "reset" ? "recover" : "resend");
        }}>{t("Resend email")}</button>}
      </div>
    </form>
  </section>;
}
