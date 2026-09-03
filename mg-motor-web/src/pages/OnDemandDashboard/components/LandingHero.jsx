import { BotIcon, ChevronRightIcon, RefreshIcon, SparklesIcon, UploadIcon } from "./icons";
// Adjust this path if your project structure differs — assumes LandingHero
// lives at the same depth as the EntranceOverlay component.
import landingBg from "../../../assets/odd/odbg1.jpg";

const FEATURES = [
  { icon: UploadIcon, title: "Upload & Analyze", text: "Drop in a PDF, Excel, or CSV and get instant KPIs and charts." },
  { icon: RefreshIcon, title: "Live App Data", text: "Pull straight from your dealers, leads, and sync logs." },
  { icon: SparklesIcon, title: "AI Insights", text: "Automatic trends, comparisons, and anomaly flags." },
  { icon: BotIcon, title: "Ask Anything", text: "Chat with your data once the dashboard is built." },
];

export default function LandingHero({ onStart }) {
  return (
    <div className="odd-landing">
      <div className="odd-landing__bg" style={{ backgroundImage: `url(${landingBg})` }} />
      <div className="odd-landing__bg-veil" />

      <span className="odd-landing__eyebrow">On-Demand Analytics</span>
      <h1 className="odd-landing__title">MG Motor On-Demand Dashboard</h1>
      <p className="odd-landing__subtitle">
        Turn any report into a live dashboard. Upload a file or pull data straight from the app — AI does the rest.
      </p>

      <div className="odd-landing__features">
        {FEATURES.map(({ icon: Icon, title, text }, i) => (
          <div
            key={title}
            className="odd-landing__feature"
            style={{ "--odd-feature-delay": `${520 + i * 90}ms` }}
          >
            <span className="odd-landing__feature-icon">
              <Icon size={18} />
            </span>
            <div>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="odd-btn odd-btn--primary odd-landing__cta" onClick={onStart}>
        Get Started
        <ChevronRightIcon size={16} />
      </button>
    </div>
  );
}