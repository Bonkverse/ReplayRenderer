import React from "react";
import { useRoute } from "./router.js";
import { SiteHeader } from "./components.jsx";
import { ABOUT_DATES_URL } from "./format.js";
import Home from "./pages/Home.jsx";
import Search from "./pages/Search.jsx";
import Watch from "./pages/Watch.jsx";

export default function App() {
  const route = useRoute();

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <SiteHeader />
      {route.name === "watch" ? (
        <Watch route={route} />
      ) : route.name === "search" ? (
        <Search route={route} />
      ) : (
        <Home />
      )}
      <footer className="site-footer">
        <a href={ABOUT_DATES_URL}>About replay dates</a>
      </footer>
    </div>
  );
}
