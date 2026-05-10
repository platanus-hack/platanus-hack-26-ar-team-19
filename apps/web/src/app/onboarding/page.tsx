"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getMe } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

const COUNTRIES = [
  { code: "AR", name: "Argentina", flag: "\u{1F1E6}\u{1F1F7}" },
  { code: "CL", name: "Chile", flag: "\u{1F1E8}\u{1F1F1}" },
  { code: "CO", name: "Colombia", flag: "\u{1F1E8}\u{1F1F4}" },
  { code: "MX", name: "México", flag: "\u{1F1F2}\u{1F1FD}" },
  { code: "BR", name: "Brasil", flag: "\u{1F1E7}\u{1F1F7}" },
  { code: "PE", name: "Perú", flag: "\u{1F1F5}\u{1F1EA}" },
  { code: "UY", name: "Uruguay", flag: "\u{1F1FA}\u{1F1FE}" },
];

type Step = "country" | "mercadopago" | "location" | "ready";

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>("country");
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);
  const [mpConnected, setMpConnected] = useState(false);
  const [mpLoading, setMpLoading] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationAddress, setLocationAddress] = useState("");
  const [locationError, setLocationError] = useState("");
  const [locationCoords, setLocationCoords] = useState<{ lat: number; lng: number } | null>(null);
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const mpResult = params.get("mp");

    getMe().then((user) => {
      if (!user) {
        router.replace("/login");
        return;
      }
      if (mpResult === "ok" || user.mpConnected) {
        setMpConnected(true);
        setStep("location");
      } else if (mpResult === "error") {
        setStep("mercadopago");
      }
      if (mpResult) {
        window.history.replaceState({}, "", "/onboarding");
      }
    }).catch(() => {
      router.replace("/login");
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectMP() {
    setMpLoading(true);
    try {
      const res = await fetch(`${API_URL}/payments/mp/connect`, { credentials: "include" });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } catch {
      setMpLoading(false);
    }
  }

  async function detectLocation() {
    setLocationLoading(true);
    setLocationError("");
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        });
      });
      const { latitude, longitude } = pos.coords;
      setLocationCoords({ lat: latitude, lng: longitude });

      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json&addressdetails=1`,
        { headers: { "User-Agent": "negocIA-marketplace" } },
      );
      const data = await res.json();
      const addr = data.address;
      const parts = [
        addr?.road,
        addr?.house_number,
        addr?.suburb || addr?.neighbourhood,
        addr?.city || addr?.town || addr?.village,
        addr?.state,
      ].filter(Boolean);
      setLocationAddress(parts.join(", ") || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
    } catch {
      setLocationError("No pudimos acceder a tu ubicacion. Escribila manualmente.");
    } finally {
      setLocationLoading(false);
    }
  }

  function goToExplore() {
    localStorage.setItem("am_onboarding_done", "1");
    router.push("/explore");
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <div className="w-full max-w-lg">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-10">
          {["country", "mercadopago", "location", "ready"].map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div
                className={`h-1.5 rounded-full flex-1 transition-colors ${
                  (step === "country" && i === 0) ||
                  (step === "mercadopago" && i <= 1) ||
                  (step === "location" && i <= 2) ||
                  (step === "ready" && i <= 3)
                    ? "bg-primary"
                    : "bg-border"
                }`}
              />
            </div>
          ))}
        </div>

        {/* Step 1: Country */}
        {step === "country" && (
          <div>
            <h1 className="text-3xl mb-2 tracking-tight" style={{ fontFamily: "var(--font-heading)", fontStyle: "italic" }}>
              Donde estas?
            </h1>
            <p className="text-muted-foreground text-sm mb-8">
              Elegi tu pais para mostrarte productos y precios relevantes.
            </p>
            <div className="grid grid-cols-2 gap-3 mb-8">
              {COUNTRIES.map((country) => (
                <button
                  key={country.code}
                  onClick={() => setSelectedCountry(country.code)}
                  className={`flex items-center gap-3 p-4 rounded-lg border text-left transition-all ${
                    selectedCountry === country.code
                      ? "border-primary bg-primary/5 ring-1 ring-primary"
                      : "border-border hover:border-foreground/20 hover:bg-muted"
                  }`}
                >
                  <span className="text-2xl">{country.flag}</span>
                  <span className="font-medium text-sm">{country.name}</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => selectedCountry && setStep("mercadopago")}
              disabled={!selectedCountry}
              className="w-full h-11 bg-foreground text-background rounded-lg text-sm font-medium disabled:opacity-30 hover:bg-foreground/90 transition-colors"
            >
              Continuar
            </button>
          </div>
        )}

        {/* Step 2: Connect MercadoPago */}
        {step === "mercadopago" && (
          <div>
            <h1 className="text-3xl mb-2 tracking-tight" style={{ fontFamily: "var(--font-heading)", fontStyle: "italic" }}>
              Conecta Mercado Pago
            </h1>
            <p className="text-muted-foreground text-sm mb-8">
              Vincula tu cuenta para que tu agente pueda cobrar y pagar automaticamente.
            </p>
            <div className="rounded-lg border border-border p-6 mb-6">
              <div className="flex items-center gap-4 mb-5">
                <img src="/mercado-pago.svg" alt="Mercado Pago" className="w-12 h-12" />
                <div>
                  <p className="font-semibold">Mercado Pago</p>
                  <p className="text-sm text-muted-foreground">
                    {mpConnected ? "Cuenta vinculada" : "No vinculado"}
                  </p>
                </div>
                {mpConnected && (
                  <div className="ml-auto w-6 h-6 rounded-full bg-accent flex items-center justify-center">
                    <span className="text-accent-foreground text-xs font-bold">&#10003;</span>
                  </div>
                )}
              </div>
              {!mpConnected && (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 text-sm text-muted-foreground">
                    <span className="text-primary mt-0.5">&#8594;</span>
                    <span>Tu agente podra pagar automaticamente cuando cierre un trato</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm text-muted-foreground">
                    <span className="text-primary mt-0.5">&#8594;</span>
                    <span>Recibi pagos cuando alguien compre tus productos</span>
                  </div>
                  <div className="flex items-start gap-3 text-sm text-muted-foreground">
                    <span className="text-primary mt-0.5">&#8594;</span>
                    <span>Tus datos financieros nunca se comparten con otros usuarios</span>
                  </div>
                </div>
              )}
            </div>
            {!mpConnected ? (
              <div className="space-y-3">
                <button
                  onClick={connectMP}
                  disabled={mpLoading}
                  className="w-full h-11 bg-[#009ee3] text-white rounded-lg text-sm font-medium hover:bg-[#007eb8] transition-colors disabled:opacity-60"
                >
                  {mpLoading ? "Redirigiendo..." : "Conectar con Mercado Pago"}
                </button>
                <button
                  onClick={() => setStep("location")}
                  className="w-full h-11 text-muted-foreground text-sm hover:text-foreground transition-colors"
                >
                  Omitir por ahora
                </button>
              </div>
            ) : (
              <button
                onClick={() => setStep("location")}
                className="w-full h-11 bg-foreground text-background rounded-lg text-sm font-medium hover:bg-foreground/90 transition-colors"
              >
                Continuar
              </button>
            )}
          </div>
        )}

        {/* Step 3: Location for delivery */}
        {step === "location" && (
          <div>
            <h1 className="text-3xl mb-2 tracking-tight" style={{ fontFamily: "var(--font-heading)", fontStyle: "italic" }}>
              Tu ubicacion
            </h1>
            <p className="text-muted-foreground text-sm mb-8">
              Necesitamos saber donde estas para coordinar entregas y mostrarte productos cercanos.
            </p>

            {locationCoords ? (
              <div className="rounded-lg border border-accent bg-accent/5 p-6 mb-6">
                <div className="flex items-start gap-4">
                  <div className="w-12 h-12 rounded-full bg-accent flex items-center justify-center shrink-0">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-foreground">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold">Ubicacion detectada</p>
                    <p className="text-sm text-muted-foreground mt-0.5 break-words">{locationAddress}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-4 mb-6">
                <button
                  onClick={detectLocation}
                  disabled={locationLoading}
                  className="w-full h-14 rounded-lg border-2 border-dashed border-border hover:border-primary/50 bg-muted/30 flex items-center justify-center gap-3 transition-colors disabled:opacity-60"
                >
                  {locationLoading ? (
                    <>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin text-primary">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      <span className="text-sm text-muted-foreground">Detectando ubicacion...</span>
                    </>
                  ) : (
                    <>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span className="text-sm font-medium">Detectar mi ubicacion</span>
                    </>
                  )}
                </button>

                {locationError && (
                  <p className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                    {locationError}
                  </p>
                )}

                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-background px-3 text-xs text-muted-foreground">o escribila</span>
                  </div>
                </div>

                <input
                  type="text"
                  placeholder="Ej: Av. Javier Prado 1234, Lima"
                  value={locationAddress}
                  onChange={(e) => {
                    setLocationAddress(e.target.value);
                    if (e.target.value.trim()) setLocationCoords({ lat: 0, lng: 0 });
                    else setLocationCoords(null);
                  }}
                  className="w-full h-11 px-3 rounded-lg border border-border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            )}

            {locationCoords ? (
              <div className="space-y-3">
                <button
                  onClick={() => setStep("ready")}
                  className="w-full h-11 bg-foreground text-background rounded-lg text-sm font-medium hover:bg-foreground/90 transition-colors"
                >
                  Continuar
                </button>
                <button
                  onClick={() => { setLocationCoords(null); setLocationAddress(""); }}
                  className="w-full h-11 text-muted-foreground text-sm hover:text-foreground transition-colors"
                >
                  Cambiar ubicacion
                </button>
              </div>
            ) : (
              <button
                onClick={() => setStep("ready")}
                className="w-full h-11 text-muted-foreground text-sm hover:text-foreground transition-colors mt-2"
              >
                Omitir por ahora
              </button>
            )}
          </div>
        )}

        {/* Step 4: Ready */}
        {step === "ready" && (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-accent mx-auto mb-6 flex items-center justify-center">
              <span className="text-accent-foreground text-2xl font-bold">&#10003;</span>
            </div>
            <h1 className="text-3xl mb-2 tracking-tight" style={{ fontFamily: "var(--font-heading)", fontStyle: "italic" }}>
              Todo listo
            </h1>
            <p className="text-muted-foreground text-sm mb-8 max-w-xs mx-auto">
              Tu cuenta esta configurada. Explora productos o habla con tu agente para empezar a comprar o vender.
            </p>
            <div className="space-y-3">
              <button
                onClick={goToExplore}
                className="w-full h-11 bg-foreground text-background rounded-lg text-sm font-medium hover:bg-foreground/90 transition-colors"
              >
                Explorar productos
              </button>
              <button
                onClick={goToExplore}
                className="w-full h-11 border border-border rounded-lg text-sm font-medium hover:bg-muted transition-colors"
              >
                Hablar con mi agente
              </button>
            </div>
          </div>
        )}

        {/* Back button */}
        {step !== "country" && step !== "ready" && (
          <button
            onClick={() => {
              if (step === "location") setStep("mercadopago");
              else if (step === "mercadopago") setStep("country");
            }}
            className="mt-4 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto block"
          >
            &#8592; Volver
          </button>
        )}
      </div>
    </div>
  );
}
