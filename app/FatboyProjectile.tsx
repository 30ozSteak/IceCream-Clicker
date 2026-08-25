"use client";

/* The image below is only a graceful fallback for browsers without WebGL. */
/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

type Point = {
  x: number;
  y: number;
};

type SplatPoint = Point & {
  id: number;
};

type FatboyProjectileProps = {
  modelUrl?: string;
  onReadyChange?: (ready: boolean) => void;
  reducedMotion: boolean;
  splat: SplatPoint | null;
  target: Point | null;
};

type SplatMesh = {
  creamMaterial: THREE.MeshPhysicalMaterial;
  group: THREE.Group;
  shadowMaterial: THREE.MeshBasicMaterial;
};

type Runtime = {
  camera: THREE.OrthographicCamera;
  height: number;
  model: THREE.Group | null;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  splat: SplatMesh;
  width: number;
};

type LoadStatus = "loading" | "ready" | "failed";

export const FATBOY_MODELS = {
  vanilla: "/models/fatboy-sandwich.glb",
} as const;

function disposeMaterial(material: THREE.Material) {
  const values = Object.values(material) as unknown[];
  for (const value of values) {
    if (!(value instanceof THREE.Texture)) {
      continue;
    }

    const image = value.image as { close?: () => void } | undefined;
    image?.close?.();
    value.dispose();
  }
  material.dispose();
}

function disposeObject(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    geometries.add(child.geometry);
    const meshMaterials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of meshMaterials) {
      materials.add(material);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach(disposeMaterial);
}

function quadraticPoint(
  start: THREE.Vector3,
  control: THREE.Vector3,
  end: THREE.Vector3,
  progress: number,
) {
  const inverse = 1 - progress;
  return new THREE.Vector3(
    inverse * inverse * start.x +
      2 * inverse * progress * control.x +
      progress * progress * end.x,
    inverse * inverse * start.y +
      2 * inverse * progress * control.y +
      progress * progress * end.y,
    inverse * inverse * start.z +
      2 * inverse * progress * control.z +
      progress * progress * end.z,
  );
}

function createSplatGeometry() {
  const outline = Array.from({ length: 20 }, (_, index) => {
    const angle = (index / 20) * Math.PI * 2;
    const radius =
      1 +
      Math.sin(angle * 3 + 0.65) * 0.105 +
      Math.sin(angle * 7 - 0.9) * 0.055;
    return new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius * 0.78,
      0,
    );
  });
  const curve = new THREE.CatmullRomCurve3(
    outline,
    true,
    "centripetal",
    0.35,
  );
  const points = curve.getPoints(72);
  const shape = new THREE.Shape();
  shape.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) {
    shape.lineTo(point.x, point.y);
  }
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    bevelEnabled: true,
    bevelSegments: 4,
    bevelSize: 0.075,
    bevelThickness: 0.055,
    curveSegments: 24,
    depth: 0.12,
    steps: 1,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
}

function createSplatMesh(): SplatMesh {
  const group = new THREE.Group();
  const geometry = createSplatGeometry();
  const creamMaterial = new THREE.MeshPhysicalMaterial({
    clearcoat: 0.22,
    clearcoatRoughness: 0.58,
    color: 0xffe8ad,
    depthWrite: false,
    metalness: 0,
    opacity: 0,
    roughness: 0.46,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x2c160c,
    depthWrite: false,
    opacity: 0,
    side: THREE.DoubleSide,
    transparent: true,
  });

  const shadow = new THREE.Mesh(geometry, shadowMaterial);
  shadow.position.set(0.045, -0.06, -0.09);
  shadow.scale.set(1.035, 1.035, 0.72);
  shadow.renderOrder = 0;
  group.add(shadow);

  const cream = new THREE.Mesh(geometry, creamMaterial);
  cream.renderOrder = 1;
  group.add(cream);

  group.visible = false;
  return { creamMaterial, group, shadowMaterial };
}

function setSplatOpacity(splat: SplatMesh, opacity: number) {
  splat.creamMaterial.opacity = opacity;
  splat.shadowMaterial.opacity = opacity * 0.24;
}

function smoothstep(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function easeOutBack(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  const overshoot = 1.32;
  return (
    1 +
    (overshoot + 1) * Math.pow(clamped - 1, 3) +
    overshoot * Math.pow(clamped - 1, 2)
  );
}

export function FatboyProjectile({
  modelUrl = FATBOY_MODELS.vanilla,
  onReadyChange,
  reducedMotion,
  splat,
  target,
}: FatboyProjectileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const flightAnimationFrameRef = useRef<number | null>(null);
  const splatAnimationFrameRef = useRef<number | null>(null);
  const [loadState, setLoadState] = useState<{
    modelUrl: string;
    status: LoadStatus;
  }>(() => ({ modelUrl, status: "loading" }));
  const loadStatus =
    loadState.modelUrl === modelUrl ? loadState.status : "loading";
  const targetX = target?.x;
  const targetY = target?.y;
  const splatId = splat?.id;
  const splatX = splat?.x;
  const splatY = splat?.y;

  useEffect(() => {
    onReadyChange?.(loadStatus === "ready");
  }, [loadStatus, onReadyChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let disposed = false;
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        canvas,
        powerPreference: "high-performance",
      });
    } catch {
      const failureTimer = window.setTimeout(() => {
        setLoadState({ modelUrl, status: "failed" });
      }, 0);
      return () => window.clearTimeout(failureTimer);
    }

    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2_000);
    camera.position.set(0, 0, 1_000);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x24180d, 2.7));
    const keyLight = new THREE.DirectionalLight(0xffffff, 4.2);
    keyLight.position.set(-220, 360, 620);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xf6be45, 2.3);
    rimLight.position.set(340, -180, 420);
    scene.add(rimLight);

    const splat = createSplatMesh();
    scene.add(splat.group);

    const runtime: Runtime = {
      camera,
      height: 1,
      model: null,
      renderer,
      scene,
      splat,
      width: 1,
    };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      runtime.width = width;
      runtime.height = height;
      camera.left = -width / 2;
      camera.right = width / 2;
      camera.top = height / 2;
      camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (runtime.model) {
        runtime.model.visible = false;
      }
      runtime.splat.group.visible = false;
      setLoadState({ modelUrl, status: "failed" });
    };
    const handleContextRestored = () => {
      if (!disposed && runtime.model) {
        renderer.render(scene, camera);
        setLoadState({ modelUrl, status: "ready" });
      }
    };
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      modelUrl,
      (gltf) => {
        if (disposed) {
          disposeObject(gltf.scene);
          return;
        }

        const bounds = new THREE.Box3().setFromObject(gltf.scene);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const largestDimension = Math.max(size.x, size.y, size.z);
        if (!Number.isFinite(largestDimension) || largestDimension <= 0) {
          disposeObject(gltf.scene);
          setLoadState({ modelUrl, status: "failed" });
          return;
        }

        gltf.scene.position.sub(center);
        gltf.scene.scale.setScalar(1 / largestDimension);
        gltf.scene.traverse((child) => {
          if (!(child instanceof THREE.Mesh)) {
            return;
          }

          child.frustumCulled = false;
          const materials = Array.isArray(child.material)
            ? child.material
            : [child.material];
          for (const material of materials) {
            if (material instanceof THREE.MeshStandardMaterial) {
              material.envMapIntensity = 0.7;
              material.needsUpdate = true;
            }
          }
        });

        const model = new THREE.Group();
        model.add(gltf.scene);
        model.visible = false;
        scene.add(model);
        runtime.model = model;
        renderer.render(scene, camera);
        setLoadState({ modelUrl, status: "ready" });
      },
      undefined,
      () => {
        if (!disposed) {
          setLoadState({ modelUrl, status: "failed" });
        }
      },
    );

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      if (flightAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(flightAnimationFrameRef.current);
        flightAnimationFrameRef.current = null;
      }
      if (splatAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(splatAnimationFrameRef.current);
        splatAnimationFrameRef.current = null;
      }
      if (runtime.model) {
        scene.remove(runtime.model);
        disposeObject(runtime.model);
      }
      scene.remove(runtime.splat.group);
      disposeObject(runtime.splat.group);
      renderer.dispose();
      runtimeRef.current = null;
    };
  }, [modelUrl]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.model || loadStatus !== "ready") {
      return;
    }

    if (flightAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(flightAnimationFrameRef.current);
      flightAnimationFrameRef.current = null;
    }

    const { camera, height, model, renderer, scene, width } = runtime;
    if (targetX === undefined || targetY === undefined) {
      model.visible = false;
      renderer.render(scene, camera);
      return;
    }

    const screenToWorld = (point: Point, z: number) =>
      new THREE.Vector3(point.x - width / 2, height / 2 - point.y, z);
    const start = screenToWorld(
      {
        x: Math.max(width * 0.8, width - 170),
        y: Math.max(height * 0.76, height - 190),
      },
      90,
    );
    const end = screenToWorld({ x: targetX, y: targetY }, 0);
    const control = new THREE.Vector3(
      (start.x + end.x) / 2 - width * 0.045,
      Math.max(start.y, end.y) + Math.min(height * 0.19, 145),
      34,
    );
    const startSize = Math.min(
      265,
      Math.max(145, Math.min(width, height) * 0.3),
    );

    model.visible = true;
    if (reducedMotion) {
      model.position.copy(end);
      model.rotation.set(-0.18, 0.58, -0.08);
      model.scale.setScalar(startSize * 0.16);
      renderer.render(scene, camera);
      return;
    }

    const startedAt = performance.now();
    const duration = 180;
    const animate = (now: number) => {
      const linearProgress = Math.min(1, (now - startedAt) / duration);
      const progress = 1 - Math.pow(1 - linearProgress, 2.35);
      model.position.copy(quadraticPoint(start, control, end, progress));
      model.rotation.set(
        -0.22 + progress * 2.35,
        0.58 + progress * 5.6,
        -0.18 + progress * 3.2,
      );
      const scale = THREE.MathUtils.lerp(
        startSize,
        startSize * 0.055,
        Math.pow(progress, 1.18),
      );
      model.scale.setScalar(scale);
      renderer.render(scene, camera);

      if (linearProgress < 1) {
        flightAnimationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        flightAnimationFrameRef.current = null;
        model.visible = false;
        renderer.render(scene, camera);
      }
    };

    flightAnimationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (flightAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(flightAnimationFrameRef.current);
        flightAnimationFrameRef.current = null;
      }
    };
  }, [loadStatus, reducedMotion, targetX, targetY]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }

    if (splatAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(splatAnimationFrameRef.current);
      splatAnimationFrameRef.current = null;
    }

    const { camera, height, renderer, scene, width } = runtime;
    const impact = runtime.splat;
    if (
      splatId === undefined ||
      splatX === undefined ||
      splatY === undefined
    ) {
      impact.group.visible = false;
      setSplatOpacity(impact, 0);
      renderer.render(scene, camera);
      return;
    }

    const radius = Math.min(
      72,
      Math.max(48, Math.min(width, height) * 0.092),
    );
    impact.group.position.set(splatX - width / 2, height / 2 - splatY, 28);
    impact.group.rotation.set(
      0,
      0,
      THREE.MathUtils.degToRad(((splatId * 37) % 17) - 8),
    );
    impact.group.visible = true;

    if (reducedMotion) {
      impact.group.scale.set(radius, radius, radius * 0.62);
      setSplatOpacity(impact, 0.96);
      renderer.render(scene, camera);
      return;
    }

    const startedAt = performance.now();
    const duration = 1_050;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      let scaleX = 1;
      let scaleY = 1;
      let scaleZ = 0.62;

      if (progress < 0.15) {
        const impactProgress = easeOutBack(progress / 0.15);
        const squashProgress = smoothstep(progress / 0.15);
        scaleX = THREE.MathUtils.lerp(0.06, 1.16, impactProgress);
        scaleY = THREE.MathUtils.lerp(0.08, 0.82, impactProgress);
        scaleZ = THREE.MathUtils.lerp(1.05, 0.34, squashProgress);
      } else if (progress < 0.32) {
        const settleProgress = smoothstep((progress - 0.15) / 0.17);
        scaleX = THREE.MathUtils.lerp(1.16, 1, settleProgress);
        scaleY = THREE.MathUtils.lerp(0.82, 1, settleProgress);
        scaleZ = THREE.MathUtils.lerp(0.34, 0.62, settleProgress);
      }

      const fadeProgress = smoothstep((progress - 0.73) / 0.27);
      const opacity =
        smoothstep(progress / 0.035) * (1 - fadeProgress);
      scaleX += fadeProgress * 0.025;
      scaleY += fadeProgress * 0.018;

      impact.group.scale.set(
        radius * scaleX,
        radius * scaleY,
        radius * scaleZ,
      );
      setSplatOpacity(impact, opacity * 0.98);
      renderer.render(scene, camera);

      if (progress < 1) {
        splatAnimationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        splatAnimationFrameRef.current = null;
        impact.group.visible = false;
        renderer.render(scene, camera);
      }
    };

    splatAnimationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (splatAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(splatAnimationFrameRef.current);
        splatAnimationFrameRef.current = null;
      }
    };
  }, [reducedMotion, splatId, splatX, splatY]);

  const fallbackStyle: CSSProperties | undefined = target
    ? { left: target.x, top: target.y }
    : undefined;

  return (
    <div className="fatboy-projectile-layer" aria-hidden="true">
      <canvas className="fatboy-projectile-canvas" ref={canvasRef} />
      {target && loadStatus !== "ready" ? (
        <img
          className="sandwich-flight sandwich-flight-fallback"
          src="/brand/vanilla-sandwich.webp"
          alt=""
          width="700"
          height="420"
          style={fallbackStyle}
        />
      ) : null}
    </div>
  );
}
