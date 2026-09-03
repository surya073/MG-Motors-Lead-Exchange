import { useEffect, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import "./AuthLayout.css";

import car1 from "../../assets/images/mgcar1.avif";
import car2 from "../../assets/images/mgcar2.jpeg";
import car3 from "../../assets/images/mgcar3.jpg";
import car4 from "../../assets/images/mgcar4.webp";

const SLIDES = [car1, car2, car3, car4];
const SLIDE_DURATION = 6000;

// Each entry is a 3-line headline. They type in, hold, then backspace
// out before the next one starts — loops forever.
const HEADLINE_SETS = [
  ["EVERY LEAD.", "EVERY DEALER.", "ONE ENGINE."],
  ["BUILT FOR SPEED.", "TUNED FOR SCALE.", "MADE FOR MG."],
  ["ONE PLATFORM.", "EVERY MARKET.", "ZERO DELAY."],
  ["DATA IN DRIVE.", "LEADS IN SYNC.", "DEALS IN MOTION."],
];

const TYPE_START_DELAY_MS = 300;
const CHAR_MS = 55;
const ERASE_CHAR_MS = 28;
const LINE_PAUSE_MS = 200;
const HOLD_MS = 2200;
const SET_PAUSE_MS = 400;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function AuthLayout() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [hasEntered, setHasEntered] = useState(false);
  const [typedLines, setTypedLines] = useState(["", "", ""]);
  const [activeLineIndex, setActiveLineIndex] = useState(-1);
  const [introDone, setIntroDone] = useState(false);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const raf = requestAnimationFrame(() => setHasEntered(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (reducedMotionRef.current) return undefined;
    const timer = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % SLIDES.length);
    }, SLIDE_DURATION);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasEntered) return undefined;

    if (reducedMotionRef.current) {
      setTypedLines(HEADLINE_SETS[0]);
      setIntroDone(true);
      return undefined;
    }

    let cancelled = false;

    (async () => {
      await wait(TYPE_START_DELAY_MS);
      let setIndex = 0;

      while (!cancelled) {
        const lines = HEADLINE_SETS[setIndex % HEADLINE_SETS.length];

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          if (cancelled) return;
          setActiveLineIndex(lineIndex);
          const line = lines[lineIndex];
          for (let charCount = 1; charCount <= line.length; charCount += 1) {
            if (cancelled) return;
            await wait(CHAR_MS);
            setTypedLines((prev) => {
              const next = [...prev];
              next[lineIndex] = line.slice(0, charCount);
              return next;
            });
          }
          await wait(LINE_PAUSE_MS);
        }
        if (cancelled) return;

        setIntroDone(true);
        setActiveLineIndex(lines.length - 1);
        await wait(HOLD_MS);

        for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
          if (cancelled) return;
          setActiveLineIndex(lineIndex);
          const line = lines[lineIndex];
          for (let charCount = line.length - 1; charCount >= 0; charCount -= 1) {
            if (cancelled) return;
            await wait(ERASE_CHAR_MS);
            setTypedLines((prev) => {
              const next = [...prev];
              next[lineIndex] = line.slice(0, charCount);
              return next;
            });
          }
        }
        if (cancelled) return;

        await wait(SET_PAUSE_MS);
        setIndex += 1;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasEntered]);

  return (
    <div className="auth-layout">
      <div className="auth-layout__visual">
        {SLIDES.map((src, index) => (
          <div
            key={src}
            className={`auth-layout__slide ${
              index === activeIndex && hasEntered ? "auth-layout__slide--active" : ""
            }`}
            style={{ backgroundImage: `url(${src})` }}
            aria-hidden={index !== activeIndex}
          />
        ))}

        {/* Layered scrim + a soft MG-red glow for depth, purely decorative */}
        <div className="auth-layout__scrim" />
        <div className="auth-layout__glow" aria-hidden="true" />
        <div className="auth-layout__grain" aria-hidden="true" />

        <div className={`auth-layout__visual-content ${hasEntered ? "auth-layout__visual-content--entered" : ""}`}>
          <div className="auth-layout__brandrow">
            <span className="auth-layout__mark" aria-hidden="true" />
            <span className="auth-layout__eyebrow">MG Dealer Network</span>
          </div>

          <h1 className="auth-layout__headline">
            <span className="sr-only">{HEADLINE_SETS[0].join(" ")}</span>
            <span aria-hidden="true">
              {typedLines.map((text, index) => (
                <span className="auth-layout__headline-line" key={index}>
                  {text}
                  {activeLineIndex === index && <span className="auth-layout__cursor" />}
                </span>
              ))}
            </span>
          </h1>

          <span
            className={`auth-layout__accent-line ${introDone ? "auth-layout__accent-line--drawn" : ""}`}
          />

          <p className={`auth-layout__quote ${introDone ? "auth-layout__quote--visible" : ""}`}>
            Connecting MG dealers and the OEM in real time — every lead tracked from delivery to outcome.
          </p>

          <div
            className={`auth-layout__dots ${introDone ? "auth-layout__dots--visible" : ""}`}
            role="presentation"
          >
            {SLIDES.map((src, index) => (
              <span
                key={src}
                className={`auth-layout__dot ${index === activeIndex ? "auth-layout__dot--active" : ""}`}
              >
                {index === activeIndex && !reducedMotionRef.current && (
                  <span
                    key={activeIndex}
                    className="auth-layout__dot-fill"
                    style={{ animationDuration: `${SLIDE_DURATION}ms` }}
                  />
                )}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="auth-layout__panel">
        <div className="auth-layout__panel-inner">
          <Outlet />
        </div>
      </div>
    </div>
  );
}