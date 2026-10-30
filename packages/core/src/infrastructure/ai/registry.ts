// Registro nombre -> constructor de proveedores (plans/).
// Agregar un motor es registrar una entrada; el resto del sistema elige por
// nombre y nunca importa una clase concreta.
//
// Puro: no lee configuración ni variables de entorno. Eso lo hace la fábrica
// (`factory.ts`), así el registro es testeable sin ninguna dependencia.

export class UnknownProviderError extends Error {}

export class ProviderRegistry<TProvider, TContext = void> {
  private readonly factories = new Map<string, (context: TContext) => TProvider>();

  /** `kind` solo sirve para que los mensajes de error digan de qué registro se trata. */
  constructor(private readonly kind: string) {}

  register(name: string, factory: (context: TContext) => TProvider): void {
    if (this.factories.has(name)) {
      throw new Error(`El proveedor de ${this.kind} "${name}" ya está registrado.`);
    }
    this.factories.set(name, factory);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }

  create(name: string, context: TContext): TProvider {
    const factory = this.factories.get(name);
    if (!factory) {
      throw new UnknownProviderError(
        `Proveedor de ${this.kind} desconocido: "${name}". Disponibles: ${this.names().join(", ") || "(ninguno)"}.`
      );
    }
    return factory(context);
  }
}
