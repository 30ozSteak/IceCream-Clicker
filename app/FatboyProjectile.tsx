"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  NO_THROW_SPIN,
  type ThrowSpin,
} from "../lib/client/throw-motion";

type Point = {
  x: number;
  y: number;
};

type FatboyProjectileProps = {
  flightDurationMs?: number;
  idle?: boolean;
  modelUrl?: string;
  onReadyChange?: (ready: boolean) => void;
  reducedMotion: boolean;
  spin?: ThrowSpin;
  target: Point | null;
};

type Runtime = {
  camera: THREE.OrthographicCamera;
  height: number;
  model: THREE.Group | null;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  width: number;
};

type SandwichFlightStyle = CSSProperties & {
  "--flight-duration": string;
  "--flight-spin-end": string;
  "--flight-target-x": string;
  "--flight-target-y": string;
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

export function FatboyProjectile({
  flightDurationMs = 800,
  idle = false,
  modelUrl = FATBOY_MODELS.vanilla,
  onReadyChange,
  reducedMotion,
  spin = NO_THROW_SPIN,
  target,
}: FatboyProjectileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const flightAnimationFrameRef = useRef<number | null>(null);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [loadState, setLoadState] = useState<{
    modelUrl: string;
    status: LoadStatus;
  }>(() => ({ modelUrl, status: "loading" }));
  const loadStatus =
    loadState.modelUrl === modelUrl ? loadState.status : "loading";
  const targetX = target?.x;
  const targetY = target?.y;

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

    const runtime: Runtime = {
      camera,
      height: 1,
      model: null,
      renderer,
      scene,
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
      setViewportVersion((version) => version + 1);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (runtime.model) {
        runtime.model.visible = false;
      }
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
      if (runtime.model) {
        scene.remove(runtime.model);
        disposeObject(runtime.model);
      }
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
    const screenToWorld = (point: Point, z: number) =>
      new THREE.Vector3(point.x - width / 2, height / 2 - point.y, z);
    const compactLandscape = width > height && height <= 560;
    const launcherPoint = {
      x: compactLandscape ? Math.max(104, width * 0.17) : width / 2,
      y: compactLandscape
        ? height - 88
        : Math.max(height * 0.72, height - 154),
    };
    const startSize = compactLandscape
      ? Math.min(185, Math.max(140, Math.min(width, height) * 0.38))
      : Math.min(225, Math.max(168, Math.min(width, height) * 0.42));

    if (targetX === undefined || targetY === undefined) {
      model.visible = idle;
      if (idle) {
        model.position.copy(screenToWorld(launcherPoint, 70));
        model.rotation.set(-0.18, 0.52, -0.08);
        model.scale.setScalar(startSize);
      }
      renderer.render(scene, camera);
      return;
    }

    const start = screenToWorld(launcherPoint, 90);
    const end = screenToWorld({ x: targetX, y: targetY }, 0);
    const control = new THREE.Vector3(
      (start.x + end.x) / 2,
      Math.max(start.y, end.y) + Math.min(height * 0.17, 132),
      34,
    );
    const endSize = Math.min(58, Math.max(46, startSize * 0.3));

    model.visible = true;
    if (reducedMotion) {
      model.position.copy(end);
      model.rotation.set(-0.18, 0.58, -0.08);
      model.scale.setScalar(endSize);
      renderer.render(scene, camera);
      return;
    }

    const startedAt = performance.now();
    const duration = Math.max(320, flightDurationMs);
    const travelDuration = Math.max(240, duration - 90);
    const animate = (now: number) => {
      const elapsed = now - startedAt;
      const linearProgress = Math.min(1, elapsed / travelDuration);
      const progress = linearProgress * linearProgress * (3 - 2 * linearProgress);
      model.position.copy(quadraticPoint(start, control, end, progress));
      model.rotation.set(
        -0.18 + progress * (0.26 + spin.xTurns * Math.PI * 2),
        0.52 + progress * (Math.PI * 0.82 + spin.yTurns * Math.PI * 2),
        -0.08 + progress * (0.2 + spin.zTurns * Math.PI * 2),
      );
      const scale = THREE.MathUtils.lerp(
        startSize,
        endSize,
        Math.pow(progress, 1.08),
      );
      model.scale.setScalar(scale);
      renderer.render(scene, camera);

      if (elapsed < duration) {
        flightAnimationFrameRef.current = window.requestAnimationFrame(animate);
      } else {
        flightAnimationFrameRef.current = null;
      }
    };

    flightAnimationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (flightAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(flightAnimationFrameRef.current);
        flightAnimationFrameRef.current = null;
      }
    };
  }, [
    flightDurationMs,
    idle,
    loadStatus,
    reducedMotion,
    spin.xTurns,
    spin.yTurns,
    spin.zTurns,
    targetX,
    targetY,
    viewportVersion,
  ]);

  const fallbackStyle: SandwichFlightStyle | undefined = target
    ? {
        left: target.x,
        top: target.y,
        "--flight-duration": `${Math.max(320, flightDurationMs)}ms`,
        "--flight-spin-end": `${8 + spin.zTurns * 360}deg`,
        "--flight-target-x": `${target.x}px`,
        "--flight-target-y": `${target.y}px`,
      }
    : undefined;

  return (
    <div
      className={`fatboy-projectile-layer${idle && !target ? " fatboy-projectile-layer-idle" : ""}`}
      aria-hidden="true"
    >
      <canvas className="fatboy-projectile-canvas" ref={canvasRef} />
      {target && loadStatus !== "ready" ? (
        <span
          className="sandwich-flight sandwich-flight-fallback fatboy-sandwich-illustration"
          style={fallbackStyle}
        >
          <i />
        </span>
      ) : null}
    </div>
  );
}
