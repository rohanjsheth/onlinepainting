export const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vViewPosition;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vTangent = normalize((modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
    vBitangent = normalize((modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

export const fragmentShader = /* glsl */ `
  uniform sampler2D uColor;
  uniform sampler2D uSurface;
  uniform vec2 uTexel;
  uniform vec2 uSize;
  uniform vec3 uLight;
  uniform float uWeave;
  uniform float uRelief;
  uniform float uRoughness;
  uniform bool uSurfaceOnly;
  uniform bool uOriginal;
  varying vec2 vUv;
  varying vec3 vViewPosition;
  varying vec3 vTangent;
  varying vec3 vBitangent;
  varying vec3 vNormal;
  const float PI = 3.14159265359;

  vec3 linearColor(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }

  void main() {
    vec3 V = normalize(vViewPosition);
    mat3 tbn = mat3(normalize(vTangent), normalize(vBitangent), normalize(vNormal));
    vec3 tangentView = vec3(dot(V, tbn[0]), dot(V, tbn[1]), dot(V, tbn[2]));
    vec2 uv = vUv;
    if (!uOriginal) {
      // Tiny relief parallax appropriate to a head tilt, with no broad image warping.
      float heightValue = texture2D(uSurface, uv).r - .5;
      uv -= tangentView.xy / max(tangentView.z, .5) * heightValue * .0015 * uRelief;
    }
    uv = clamp(uv, uTexel * .5, vec2(1.0) - uTexel * .5);
    vec3 color = linearColor(texture2D(uColor, uv).rgb);
    if (uOriginal) {
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
      return;
    }

    vec4 surface = texture2D(uSurface, uv);
    float dx = texture2D(uSurface, uv + vec2(uTexel.x, 0.0)).r - texture2D(uSurface, uv - vec2(uTexel.x, 0.0)).r;
    float dy = texture2D(uSurface, uv + vec2(0.0, uTexel.y)).r - texture2D(uSurface, uv - vec2(0.0, uTexel.y)).r;
    vec2 slope = vec2(dx, dy) * uRelief * 5.0;

    // Woven threads use painting coordinates, so they stay attached during view changes.
    // Pixel-footprint filtering fades them at a distance to prevent shimmer and moiré.
    vec2 threads = uv * uSize * 320.0;
    vec2 footprint = fwidth(threads);
    vec2 visible = 1.0 - smoothstep(vec2(.25), vec2(.8), footprint);
    vec2 wave = sin(threads * 2.0 * PI);
    float alternating = cos(threads.x * PI) * cos(threads.y * PI);
    float exposedCanvas = 1.0 - surface.g * .75;
    slope += wave * visible * uWeave * .17 * exposedCanvas * (1.0 + .15 * alternating);
    vec3 N = normalize(tbn * normalize(vec3(-slope, 1.0)));
    vec3 L = normalize((viewMatrix * vec4(uLight, 0.0)).xyz);
    vec3 H = normalize(L + V);
    float NoL = max(dot(N, L), 0.0);
    float NoV = max(dot(N, V), .001);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    float roughness = clamp(uRoughness + (surface.b - .5) * .16, .15, .95);
    float alpha = roughness * roughness;
    float alpha2 = alpha * alpha;
    float denom = NoH * NoH * (alpha2 - 1.0) + 1.0;
    float D = alpha2 / max(PI * denom * denom, .00001);
    float k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
    float Gv = NoV / (NoV * (1.0 - k) + k);
    float Gl = NoL / (NoL * (1.0 - k) + k);
    float F = .04 + .96 * pow(1.0 - VoH, 5.0);
    float specular = D * Gv * Gl * F / max(4.0 * NoV * NoL, .001);
    if (uSurfaceOnly) color = linearColor(vec3(.72, .71, .65));
    float flatLight = max(dot(normalize(vNormal), L), 0.0);
    // Exposure normalization preserves the original color as light elevation changes.
    float diffuse = (.50 + .68 * NoL) / (.50 + .68 * flatLight);
    vec3 lit = color * diffuse + vec3(1.0, .96, .86) * specular * NoL * .75;
    gl_FragColor = vec4(lit, 1.0);
    #include <colorspace_fragment>
  }
`;
