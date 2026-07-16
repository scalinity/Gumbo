// The orb's plasma interior, per-pixel (SwiftUI colorEffect stitchable shader).
// Differential swirl (rotation angle grows with radius) + three detuned trig octaves
// give a fluid, non-repeating churn; energy maps deep → base → hot → white-hot.
// `aliveness` scales flow speed and luminosity (running burns, done drifts calmly);
// `breath` (already amplitude-scaled and reduce-motion-zeroed by the Swift side)
// swells the outer bloom.
#include <metal_stdlib>
using namespace metal;

static float2 swirl(float2 p, float a) {
    float c = cos(a), s = sin(a);
    return float2(c * p.x - s * p.y, s * p.x + c * p.y);
}

static float flowNoise(float2 p, float t) {
    // Gentle differential rotation for drift, then a domain warp — the warp is what
    // breaks the coherent "pinwheel" arms into cloudy, plasma-like turbulence.
    float2 q = swirl(p, 0.30 * t + 0.9 * length(p));
    q += 0.45 * float2(sin(q.y * 1.7 + t * 0.6), cos(q.x * 1.9 - t * 0.5));
    float n = sin(q.x * 3.1 + t * 0.9) * sin(q.y * 3.7 - t * 0.7);
    q = swirl(q * 1.9, -0.22 * t + 2.3);
    q += 0.30 * float2(cos(q.y * 2.3 - t * 0.8), sin(q.x * 2.1 + t * 0.7));
    n += 0.6 * sin(q.x * 4.3 - t * 1.3) * sin(q.y * 3.3 + t * 1.1);
    q = swirl(q * 1.7, 0.13 * t);
    n += 0.35 * sin(q.x * 6.1 + t * 1.9) * sin(q.y * 5.7 - t * 1.6);
    return n / 1.95;
}

[[stitchable]] half4 orb(float2 position, half4 currentColor,
                         float2 size, float time, float aliveness, float breath,
                         half4 hotColor, half4 baseColor, half4 deepColor) {
    float2 uv = (position / size) * 2.0 - 1.0; // [-1, 1], y down
    float r = length(uv);
    float coreR = 0.645; // core diameter ≈ the view's nominal orb diameter
    float t = time * (0.22 + 0.78 * aliveness);

    float n = flowNoise(uv / coreR, t);
    float depth = 1.0 - smoothstep(0.15, 1.0, r / coreR); // brighter toward center
    float energy = clamp(0.52 + 0.48 * n, 0.0, 1.0) * (0.22 + 0.78 * depth);
    energy = energy * energy * (3.0 - 2.0 * energy); // contrast: deeper darks, hotter brights

    float3 cHot = float3(hotColor.rgb);
    float3 cBase = float3(baseColor.rgb);
    float3 cDeep = float3(deepColor.rgb);

    float3 col = mix(cDeep, cBase, smoothstep(0.12, 0.55, energy));
    col = mix(col, cHot, smoothstep(0.50, 0.85, energy));
    // white-hot flecks only while genuinely alive
    col = mix(col, float3(1.0, 0.96, 0.88), smoothstep(0.84, 1.0, energy) * 0.65 * aliveness);

    // fresnel-style rim light just inside the surface
    float rim = smoothstep(coreR * 0.80, coreR * 0.98, r) * (1.0 - smoothstep(coreR * 0.98, coreR * 1.04, r));
    col += cHot * rim * (0.25 + 0.30 * aliveness);

    // soft specular, upper-left — sphere, not sticker
    float2 sp = uv - float2(-0.30, -0.36);
    col += float3(1.0) * exp(-dot(sp, sp) * 13.0) * 0.20;

    float coreA = 1.0 - smoothstep(coreR - 0.015, coreR + 0.015, r);

    // luminous bloom beyond the surface; swells with the breath
    float glow = exp(-max(r - coreR, 0.0) * 5.0);
    float glowA = glow * (1.0 - coreA) * (0.30 + 0.14 * breath) * (0.2 + 0.8 * aliveness);

    float3 outColor = col * coreA + cBase * glowA; // premultiplied by coverage
    float alpha = clamp(coreA + glowA, 0.0, 1.0);
    return half4(half3(outColor), half(alpha));
}
