"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type Theme = "dark" | "light" | "midnight" | "ocean" | "forest" | "sunset";

const THEMES: { value: Theme; label: string; icon: string }[] = [
  { value: "dark", label: "Dark", icon: "🌙" },
  { value: "light", label: "Light", icon: "☀️" },
  { value: "midnight", label: "Midnight", icon: "🌑" },
  { value: "ocean", label: "Ocean", icon: "🌊" },
  { value: "forest", label: "Forest", icon: "🌲" },
  { value: "sunset", label: "Sunset", icon: "🌅" },
];

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (t: Theme) => void;
  themes: typeof THEMES;
}>({ theme: "dark", setTheme: () => {}, themes: THEMES });

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    (async () => {
      const saved = localStorage.getItem("stockfolio-theme") as Theme | null;
      setThemeState(saved && THEMES.some((t) => t.value === saved) ? saved : "dark");
    })();
  }, []);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("stockfolio-theme", t);
    // Only touch the theme class — never wipe other classes (fonts, h-full, etc.)
    const el = document.documentElement;
    THEMES.forEach((x) => el.classList.remove(x.value));
    el.classList.add(t);
  };

  // The inline script in layout.tsx applies the theme class before hydration,
  // so children can render immediately — no flash-of-wrong-theme and no
  // remount that would reset component state.
  return (
    <ThemeContext.Provider value={{ theme, setTheme, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}
