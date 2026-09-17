"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * A self-contained WebGL globe for dashboard empty states. It deliberately uses
 * generated geometry instead of a map texture so it remains crisp, lightweight,
 * and available offline.
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
        color: 0x0d7c9d,
        transparent: true,
        opacity: 0.08,
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

    const dotPositions: number[] = [];
    for (let latitude = -72; latitude <= 72; latitude += 12) {
      for (let longitude = 0; longitude < 360; longitude += 12) {
        const jitter = Math.sin(latitude * 17 + longitude * 11) * 0.045;
        const phi = THREE.MathUtils.degToRad(90 - latitude + jitter * 12);
        const theta = THREE.MathUtils.degToRad(longitude + jitter * 12);
        dotPositions.push(
          1.53 * Math.sin(phi) * Math.cos(theta),
          1.53 * Math.cos(phi),
          1.53 * Math.sin(phi) * Math.sin(theta),
        );
      }
    }
    const dotsGeometry = new THREE.BufferGeometry();
    dotsGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dotPositions, 3));
    const dots = new THREE.Points(dotsGeometry, new THREE.PointsMaterial({
      color: 0xaff5ff,
      size: 0.026,
      transparent: true,
      opacity: 0.82,
      sizeAttenuation: true,
    }));
    globe.add(dots);

    const marker = new THREE.Group();
    const markerPosition = new THREE.Vector3(0.55, 0.88, 1.08).normalize();
    marker.position.copy(markerPosition.multiplyScalar(1.53));
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), markerPosition.normalize());
    const pin = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.28, 20),
      new THREE.MeshBasicMaterial({ color: 0x00d8ff }),
    );
    pin.position.y = 0.14;
    marker.add(pin);
    const beacon = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.16, 32),
      new THREE.MeshBasicMaterial({ color: 0x61e8ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    beacon.rotation.x = -Math.PI / 2;
    marker.add(beacon);
    globe.add(marker);

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
    const render = (now: number) => {
      const elapsed = (now - startedAt) / 1000;
      if (!reducedMotion) {
        globe.rotation.y = elapsed * 0.2;
        globe.rotation.x = Math.sin(elapsed * 0.35) * 0.08;
        beacon.scale.setScalar(1 + (Math.sin(elapsed * 3) + 1) * 0.12);
      }
      renderer.render(scene, camera);
      if (!reducedMotion) frame = requestAnimationFrame(render);
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
      dotsGeometry.dispose();
      (dots.material as THREE.Material).dispose();
      pin.geometry.dispose();
      (pin.material as THREE.Material).dispose();
      beacon.geometry.dispose();
      (beacon.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={className} />;
}
