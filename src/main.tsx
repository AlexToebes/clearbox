import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

function applyColorScheme(query: MediaQueryList | MediaQueryListEvent) {
  document.documentElement.classList.toggle("dark", query.matches);
}

const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
applyColorScheme(darkModeQuery);
darkModeQuery.addEventListener("change", applyColorScheme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
