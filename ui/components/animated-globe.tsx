"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Shared WebGL loading mark for the dashboard. The land-like pixels are a
 * decorative, deterministic pattern — they do not represent node locations or
 * operational geography. Generated geometry keeps it crisp and available offline.
 */
export function AnimatedGlobe({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 0, 5.2);
    const globe = new THREE.Group();
    scene.add(globe);

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1.48, 64, 40),
      new THREE.MeshBasicMaterial({
        color: 0x15152f,
        transparent: true,
        opacity: 0.18,
        side: THREE.FrontSide,
      }),
    );
    globe.add(shell);

    const lineMaterial = new THREE.LineBasicMaterial({
      color: 0x42d8ff,
      transparent: true,
      opacity: 0.34,
    });
    const rings = new THREE.Group();
    for (let latitude = -60; latitude <= 60; latitude += 20) {
      const points: THREE.Vector3[] = [];
      const phi = THREE.MathUtils.degToRad(90 - latitude);
      for (let longitude = 0; longitude <= 360; longitude += 4) {
        const theta = THREE.MathUtils.degToRad(longitude);
        points.push(new THREE.Vector3(
          1.5 * Math.sin(phi) * Math.cos(theta),
          1.5 * Math.cos(phi),
          1.5 * Math.sin(phi) * Math.sin(theta),
        ));
      }
      rings.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
    }
    for (let longitude = 0; longitude < 360; longitude += 24) {
      const points: THREE.Vector3[] = [];
      const theta = THREE.MathUtils.degToRad(longitude);
      for (let latitude = -90; latitude <= 90; latitude += 4) {
        const phi = THREE.MathUtils.degToRad(90 - latitude);
        points.push(new THREE.Vector3(
          1.5 * Math.sin(phi) * Math.cos(theta),
          1.5 * Math.cos(phi),
          1.5 * Math.sin(phi) * Math.sin(theta),
        ));
      }
      rings.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial));
    }
    globe.add(rings);

    // Stylised "pixel continents": deliberately abstract clusters rather than
    // geographic data, so the loading mark never implies live node placement.
    const clusters = [
      [-36, 8, 34, 22], [-5, -2, 27, 29], [35, 18, 40, 19],
      [66, -18, 22, 13], [111, 7, 40, 22], [145, -29, 20, 12],
    ];
    const dotPositions: number[] = [];
    for (const [centerLng, centerLat, width, height] of clusters) {
      for (let latitude = centerLat - height; latitude <= centerLat + height; latitude += 5) {
        for (let longitude = centerLng - width; longitude <= centerLng + width; longitude += 5) {
          const normalized = ((longitude - centerLng) / width) ** 2 + ((latitude - centerLat) / height) ** 2;
          const noise = Math.sin(longitude * 1.91 + latitude * 2.73);
          if (normalized + noise * 0.19 > 0.9) continue;
          const phi = THREE.MathUtils.degToRad(90 - latitude);
          const theta = THREE.MathUtils.degToRad(longitude);
          dotPositions.push(
            1.535 * Math.sin(phi) * Math.cos(theta),
            1.535 * Math.cos(phi),
            1.535 * Math.sin(phi) * Math.sin(theta),
          );
        }
      }
    }
    const dotsGeometry = new THREE.BufferGeometry();
    dotsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dotPositions, 3));
    const dots = new THREE.Points(dotsGeometry, new THREE.PointsMaterial({
      color: 0x7dd3fc,
      size: 0.042,
      transparent: true,
      opacity: 0.82,
      sizeAttenuation: true,
    }));
    globe.add(dots);

    const arcs = new THREE.Group();
    const arcMaterial = new THREE.LineBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.3 });
    for (const [from, to] of [[[-34, 8], [35, 18]], [[35, 18], [111, 7]], [[-5, -2], [66, -18]]]) {
      const point = ([longitude, latitude]: number[]) => {
        const phi = THREE.MathUtils.degToRad(90 - latitude);
        const theta = THREE.MathUtils.degToRad(longitude);
        return new THREE.Vector3(
          1.54 * Math.sin(phi) * Math.cos(theta),
          1.54 * Math.cos(phi),
          1.54 * Math.sin(phi) * Math.sin(theta),
        );
      };
      const start = point(from);
      const end = point(to);
      const middle = start.clone().add(end).normalize().multiplyScalar(1.9);
      arcs.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        new THREE.QuadraticBezierCurve3(start, middle, end).getPoints(24),
      ), arcMaterial));
    }
    globe.add(arcs);

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const startedAt = performance.now();
    let visible = !document.hidden;
    const onVisibilityChange = () => {
      visible = !document.hidden;
      if (visible && !reducedMotion && !frame) frame = requestAnimationFrame(render);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const render = (now: number) => {
      frame = 0;
      const elapsed = (now - startedAt) / 1000;
      if (!reducedMotion) {
        globe.rotation.y = elapsed * 0.2;
        globe.rotation.x = Math.sin(elapsed * 0.35) * 0.08;
      }
      renderer.render(scene, camera);
      if (!reducedMotion && visible) frame = requestAnimationFrame(render);
    };
    frame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      shell.geometry.dispose();
      (shell.material as THREE.Material).dispose();
      lineMaterial.dispose();
      rings.traverse((object) => {
        if (object instanceof THREE.Line) object.geometry.dispose();
      });
      arcs.traverse((object) => {
        if (object instanceof THREE.Line) object.geometry.dispose();
      });
      arcMaterial.dispose();
      dotsGeometry.dispose();
      (dots.material as THREE.Material).dispose();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
