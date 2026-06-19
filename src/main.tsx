import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppearanceProvider } from "./shared/appearance/AppearanceProvider";
import { NotificationsProvider } from "./shared/notifications/NotificationsProvider";
import { GeneralProvider } from "./shared/general/GeneralProvider";
import { SnoozeProvider } from "./shared/snooze/SnoozeProvider";
import { QueryProvider } from "./app/QueryProvider";
import { ShortcutsProvider } from "./features/shortcuts/ShortcutsProvider";
import "@fontsource-variable/plus-jakarta-sans";
import "./shared/theme/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryProvider>
      <AppearanceProvider>
        <NotificationsProvider>
          <GeneralProvider>
            <SnoozeProvider>
              <ShortcutsProvider>
                <App />
              </ShortcutsProvider>
            </SnoozeProvider>
          </GeneralProvider>
        </NotificationsProvider>
      </AppearanceProvider>
    </QueryProvider>
  </React.StrictMode>
);
