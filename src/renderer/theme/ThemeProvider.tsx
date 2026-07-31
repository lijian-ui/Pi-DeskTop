import type { ReactNode } from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Wraps the app with next-themes (an existing, well-maintained React theme
 * library) so we don't hand-roll the switching/persistence logic.
 *
 * - `attribute="data-theme"`  → writes `data-theme="light|dark"` on <html>,
 *   which our `[data-theme="light"]` token overrides in tokens.css pick up.
 * - `defaultTheme="dark"`      → matches the existing look (tokens.css :root).
 * - `enableSystem`             → offers a "System" option that follows
 *   `prefers-color-scheme`.
 * - `disableTransitionOnChange`→ avoids a flash of transitioning colors when
 *   switching themes.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      themes={["light", "dark"]}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
