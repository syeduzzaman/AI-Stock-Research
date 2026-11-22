import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { LanguageProvider } from "./language.jsx";
import "./style.css";

createRoot(document.getElementById("root")).render(
  <LanguageProvider><App /></LanguageProvider>
);
