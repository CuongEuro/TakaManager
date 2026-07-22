"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const FALLBACK_IMAGE = "https://placehold.co/40x40?text=POD";
const PREVIEW_MAX_SIZE = 320;
const PREVIEW_GAP = 12;
const VIEWPORT_GUTTER = 12;

interface PreviewPosition {
  left: number;
  top: number;
  size: number;
}

export function ProductThumbnail({
  src,
  alt,
  className = "",
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  const [preview, setPreview] = useState<PreviewPosition | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const imageSrc = src && failedSrc !== src ? src : FALLBACK_IMAGE;

  useEffect(() => {
    if (!preview) return;

    const closePreview = () => setPreview(null);
    window.addEventListener("resize", closePreview);
    window.addEventListener("scroll", closePreview, true);

    return () => {
      window.removeEventListener("resize", closePreview);
      window.removeEventListener("scroll", closePreview, true);
    };
  }, [preview]);

  function openPreview(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const size = Math.min(
      PREVIEW_MAX_SIZE,
      window.innerWidth - VIEWPORT_GUTTER * 2,
      window.innerHeight - VIEWPORT_GUTTER * 2,
    );

    let left = rect.right + PREVIEW_GAP;
    if (left + size > window.innerWidth - VIEWPORT_GUTTER) {
      left = rect.left - size - PREVIEW_GAP;
    }
    left = Math.max(
      VIEWPORT_GUTTER,
      Math.min(left, window.innerWidth - size - VIEWPORT_GUTTER),
    );

    const centeredTop = rect.top + rect.height / 2 - size / 2;
    const top = Math.max(
      VIEWPORT_GUTTER,
      Math.min(centeredTop, window.innerHeight - size - VIEWPORT_GUTTER),
    );

    setPreview({ left, top, size });
  }

  return (
    <>
      <span
        className="inline-flex shrink-0 cursor-zoom-in"
        onMouseEnter={(event) => openPreview(event.currentTarget)}
        onMouseLeave={() => setPreview(null)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageSrc}
          alt={alt}
          className={`h-10 w-10 rounded-md object-cover ${className}`}
          loading="lazy"
          decoding="async"
          onError={() => {
            if (imageSrc !== FALLBACK_IMAGE) setFailedSrc(imageSrc);
          }}
        />
      </span>

      {preview &&
        createPortal(
          <div
            aria-hidden="true"
            data-testid="product-thumbnail-preview"
            className="pointer-events-none fixed z-[100] overflow-hidden rounded-xl border border-slate-200 bg-white p-2 shadow-2xl"
            style={{
              left: preview.left,
              top: preview.top,
              width: preview.size,
              height: preview.size,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageSrc}
              alt=""
              className="h-full w-full rounded-lg object-contain"
              onError={() => {
                if (imageSrc !== FALLBACK_IMAGE) setFailedSrc(imageSrc);
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
