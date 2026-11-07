"use client";

import { useEffect, useRef } from "react";
import { OceanEngine } from "./engine";


/** Glyphs come from the canvas's font-family, so give it (or a parent) a monospace font. */
export function AsciiOcean({ className, only }: { className?: string; only?: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new OceanEngine(canvas, only);
    return () => engine.destroy();
    // The roster is fixed for the life of the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={`ascii-ocean ${className ?? ""}`} />;
}
