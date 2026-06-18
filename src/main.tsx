import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./shared/appearance/AppearanceProvider";
import { QueryProvider } from "./app/QueryProvider";
import "@fontsource-variable/plus-jakarta-sans";
import "./shared/theme/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryProvider>
      <AppearanceProvider>
        <App />
      </AppearanceProvider>
    </QueryProvider>
  </React.StrictMode>
);
