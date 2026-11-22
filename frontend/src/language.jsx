import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { translate } from "./i18n.js";

const Language = createContext(null);
const preference = "stock-research-language";

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(() => {
    try { return localStorage.getItem(preference) === "de" ? "de" : "en"; }
    catch { return "en"; }
  });

  useEffect(() => {
    document.documentElement.lang = language;
    try { localStorage.setItem(preference, language); }
    catch { /* The language still applies for this visit. */ }
  }, [language]);

  const value = useMemo(() => {
    const locale = language === "de" ? "de-DE" : "en-US";
    const number = options => new Intl.NumberFormat(locale, options);
    const date = options => new Intl.DateTimeFormat(locale, options);
    const currency = { style: "currency", currency: "USD" };
    return {
      language, setLanguage, t: (message, values) => translate(language, message, values),
      money: number(currency), signedMoney: number({ ...currency, signDisplay: "exceptZero" }),
      signedPercent: number({ style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 2 }),
      shareCount: number({ maximumFractionDigits: 6 }), decimal: number({ maximumFractionDigits: 2 }),
      dateLabel: value => date({ dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)),
      calendar: date({ month: "short", day: "numeric", timeZone: "UTC" }),
      runDate: date({ dateStyle: "medium", timeStyle: "short" }),
    };
  }, [language]);

  return <Language.Provider value={value}>{children}</Language.Provider>;
}

export function useLanguage() { return useContext(Language); }
