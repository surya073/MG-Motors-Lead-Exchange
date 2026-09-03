import logoSrc from "../../assets/images/mg-logo-single.png";
import "./Logo.css";

export default function Logo({ size = "md" }) {
  return (
    <img
      src={logoSrc}
      alt="MG Motor Lead Exchange"
      className={`logo logo--${size}`}
    />
  );
}