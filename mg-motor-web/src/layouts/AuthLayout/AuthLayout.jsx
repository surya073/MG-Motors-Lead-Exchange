import { useEffect, useState } from "react";
import { Outlet } from "react-router-dom";
import "./AuthLayout.css";

import mgLogo from "../../assets/images/mg-logo-single.png";
import banner1 from "../../assets/banners/bgbanner1.jpg";
import banner2 from "../../assets/banners/bgbanner2.jpg";
import banner3 from "../../assets/banners/bgbanner3.jpg";
import banner4 from "../../assets/banners/bgbanner4.jpg";
import banner5 from "../../assets/banners/bgbanner5.jpg";
import banner6 from "../../assets/banners/bgbanner6.jpg";
import banner7 from "../../assets/banners/bgbanner7.jpg";

const SLIDES = [banner1, banner2, banner3, banner4, banner5, banner6, banner7];
const SLIDE_DURATION = 7000;

const FEATURES = [
  {
    title: "Lead Exchange",
    desc: "Two-way. Faster.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 1l4 4-4 4" /><path d="M3 11V9a4 4 0 0 1 4-4h14" />
        <path d="M7 23l-4-4 4-4" /><path d="M21 13v2a4 4 0 0 1-4 4H3" />
      </svg>
    ),
  },
  {
    title: "Dealer Connectivity",
    desc: "More Possibilities.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    title: "Business Growth",
    desc: "Together We Grow.",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
      </svg>
    ),
  },
];

export default function AuthLayout() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setHasEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % SLIDES.length);
    }, SLIDE_DURATION);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="auth-layout">
      <div className="auth-layout__visual">
        {SLIDES.map((src, index) => (
          <div
            key={src}
            className={`auth-layout__slide ${
              index === activeIndex && hasEntered ? "auth-layout__slide--active" : ""
            }`}
            style={{ backgroundImage: `url(${src})`, animationDuration: `${SLIDE_DURATION}ms` }}
            aria-hidden={index !== activeIndex}
          />
        ))}

        <div className="auth-layout__scrim" />

        <div className={`auth-layout__visual-content ${hasEntered ? "auth-layout__visual-content--entered" : ""}`}>
          <div className="auth-layout__brandrow">
            <img src={mgLogo} alt="MG Motor" className="auth-layout__logo" />
            <div className="auth-layout__wordmark">
              <span>MG MOTOR</span>
              <span>DEALER NETWORK</span>
            </div>
          </div>

          <div className="auth-layout__copy">
            <p className="auth-layout__eyebrow">DRIVE TOGETHER</p>
            <h1 className="auth-layout__headline">
              Stronger<br /><span className="auth-layout__headline-accent">Together</span>
            </h1>
            <span className="auth-layout__accent-line" />
            <p className="auth-layout__quote">
              Manage leads. Exchange opportunities. Build a stronger dealer network.
            </p>
          </div>

          <div className="auth-layout__features">
            {FEATURES.map((feature) => (
              <div className="auth-layout__feature" key={feature.title}>
                <span className="auth-layout__feature-icon">{feature.icon}</span>
                <span className="auth-layout__feature-title">{feature.title}</span>
                <span className="auth-layout__feature-desc">{feature.desc}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="auth-layout__footer">
          <span className="auth-layout__footer-mark" aria-hidden="true" />
          <span>DRIVEN BY PEOPLE. POWERED BY PARTNERSHIP.</span>
        </div>
      </div>

      <div className="auth-layout__panel">
        <div className="auth-layout__panel-eyebrow">
          <span aria-hidden="true">→</span> MG Motor Dealer Network
        </div>
        <div className="auth-layout__panel-inner">
          <Outlet />
        </div>
        <div className="auth-layout__panel-footer">/// MG MORRIS GARAGES ///</div>
      </div>
    </div>
  );
}