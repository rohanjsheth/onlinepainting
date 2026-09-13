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
    // Relief height is in painting-space units. The same height scale drives
    // parallax, normals, and light occlusion so those cues agree as the view moves.
    float edge = smoothstep(0.0, .018, min(min(vUv.x, vUv.y), min(1.0 - vUv.x, 1.0 - vUv.y)));
    float reliefDepth = .014 * uRelief * edge * texture2D(uSurface, vUv).a;
    vec2 uv = vUv;
    if (!uOriginal && reliefDepth > .00001) {
      vec2 offset = tangentView.xy / max(tangentView.z, .5) * reliefDepth / uSize;
      vec2 stepUv = offset / 20.0;
      uv += offset * .5;
      float rayDepth = 0.0;
      float surfaceDepth = 1.0 - texture2D(uSurface, uv).r;
      for (int i = 0; i < 20; i++) {
        if (rayDepth >= surfaceDepth) break;
        uv -= stepUv;
        rayDepth += .05;
        surfaceDepth = 1.0 - texture2D(uSurface, uv).r;
      }
      // Interpolate the crossing instead of showing discrete ray-march layers.
      vec2 previousUv = uv + stepUv;
      float after = surfaceDepth - rayDepth;
      float before = 1.0 - texture2D(uSurface, previousUv).r - rayDepth + .05;
      float blend = clamp(after / min(after - before, -.00001), 0.0, 1.0);
      uv = mix(uv, previousUv, blend);
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
    vec2 slope = vec2(dx, dy) * reliefDepth * surface.a / (2.0 * uTexel * uSize);

    // Woven threads use painting coordinates, so they stay attached during view changes.
    // Pixel-footprint filtering fades them at a distance to prevent shimmer and moiré.
    vec2 threads = uv * uSize * 320.0;
    vec2 footprint = fwidth(threads);
    vec2 visible = 1.0 - smoothstep(vec2(.25), vec2(.8), footprint);
    vec2 wave = sin(threads * 2.0 * PI);
    float alternating = cos(threads.x * PI) * cos(threads.y * PI);
    float exposedCanvas = (1.0 - surface.g * .75) * surface.a;
    slope += wave * visible * uWeave * .17 * exposedCanvas * (1.0 + .15 * alternating);
    vec3 N = normalize(tbn * normalize(vec3(-slope, 1.0)));
    vec3 L = normalize((viewMatrix * vec4(uLight, 0.0)).xyz);
    vec3 H = normalize(L + V);
    float NoL = max(dot(N, L), 0.0);
    float NoV = max(dot(N, V), .001);
    float NoH = max(dot(N, H), 0.0);
    float VoH = max(dot(V, H), 0.0);
    // Broad raised paint has a softer satin finish; grooves stay more matte.
    float roughness = clamp(uRoughness + .04 - surface.g * .08 + (surface.b - .5) * .10, .22, .95);
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
    // Short horizon rays cast soft local shadows into nearby paint grooves.
    vec3 tangentLight = vec3(dot(L, tbn[0]), dot(L, tbn[1]), dot(L, tbn[2]));
    vec2 lightStep = normalize(tangentLight.xy + vec2(.00001)) * .0025;
    float rise = max(tangentLight.z, 0.0) / max(length(tangentLight.xy), .1);
    float occlusion = 0.0;
    if (reliefDepth > .00001) {
      for (int i = 1; i <= 10; i++) {
        float distance = float(i) * .0025;
        vec2 sampleUv = uv + lightStep * float(i) / uSize;
        float obstacle = texture2D(uSurface, clamp(sampleUv, uTexel, 1.0 - uTexel)).r;
        float clearance = (obstacle - surface.r) * reliefDepth - rise * distance;
        float softness = .00035 + distance * .055;
        occlusion = max(occlusion, smoothstep(.00015, softness, clearance) * (1.0 - float(i) * .045));
      }
    }
    float visibility = 1.0 - .28 * occlusion;
    // Strong directional light plus a soft fill: relief has contrast without
    // flattening the whole image's exposure as the light elevation changes.
    float diffuse = (.55 + .80 * NoL * visibility) / (.55 + .80 * flatLight);
    vec3 lit = color * diffuse + vec3(1.0, .97, .90) * specular * NoL * visibility * .85 * surface.a;
    gl_FragColor = vec4(lit, 1.0);
    #include <colorspace_fragment>
  }
`;
