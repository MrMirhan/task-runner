"use client";

import { useLayoutEffect, useRef } from "react";

type Props = Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "rows"> & { minRows?: number };

/** A textarea that grows with its content instead of scrolling. */
export default function AutoTextarea({ minRows = 8, value, className = "", ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight + 2}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [value]);

  return <textarea ref={ref} rows={minRows} value={value} className={`field field-mono ${className}`} {...rest} />;
}
