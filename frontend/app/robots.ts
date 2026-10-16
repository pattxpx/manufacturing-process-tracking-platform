import type { MetadataRoute } from "next";

// The whole site is behind the sign-in, so there is nothing to crawl and no sitemap.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
