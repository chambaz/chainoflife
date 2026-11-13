// Generated from game_of_life.spec.xdr - GameOfLife interface v0.1.0
// DO NOT EDIT. Re-run codegen to update.

import * as __gh_protocol from "@thruputchain/protocol";
import * as __gh_protocol_utils from "@thruputchain/protocol/utils";
import * as __gh_contract_spec from "@thruputchain/contract-spec";
import * as __gh_client_contract from "@thruputchain/client/contract";

const __gh_s = __gh_contract_spec.contractSpecString;

const __gh_entrypoints = {
  GameOfLife: {
    v0_1: {
      advance: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("ad6a63c476e25d49"),
      ),
      getChunk: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("5d130cba138a2fa2"),
      ),
      getMetadata: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("414af744a7b4d20c"),
      ),
      initialize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("02788e24733cc45c"),
      ),
      resize: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("ef212934cbb78d6d"),
      ),
    },
  },
} as const;

export namespace game_of_life {
  export namespace v0_1 {
    export namespace types {
      export type GameOfLifeError = 1n | 2n | 3n | 4n | 5n | 6n | 7n | 8n;

      export interface WorldMetadata {
        epoch: bigint;
        size: bigint;
        generation: bigint;
        seed: bigint;
        population: bigint;
        state_digest: __gh_client_contract.FixedBytes<32>;
        resizable: boolean;
      }

      export interface GenerationAdvanced extends __gh_client_contract.DecodedContractEvent<
        "GenerationAdvanced",
        { advanced_by: __gh_protocol.ContractAddress },
        {
          epoch: bigint;
          generation: bigint;
          population: bigint;
          state_digest: __gh_client_contract.FixedBytes<32>;
        }
      > {}

      export interface GenerationAdvancedFilter {
        advanced_by?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface WorldInitialized extends __gh_client_contract.DecodedContractEvent<
        "WorldInitialized",
        {},
        {
          epoch: bigint;
          size: bigint;
          seed: bigint;
          population: bigint;
          state_digest: __gh_client_contract.FixedBytes<32>;
        }
      > {}

      export type WorldInitializedFilter = globalThis.Record<string, never>;
    }
  }
}

export namespace GameOfLife {
  export namespace v0_1 {
    export type AdvanceArgs = void;
    export type AdvanceResult =
      __gh_codegen.game_of_life$v0_1$types$WorldMetadata;

    export interface GetChunkArgs {
      row: bigint;
      part: bigint;
    }
    export type GetChunkResult = __gh_client_contract.FixedBytes<1000>;

    export type GetMetadataArgs = void;
    export type GetMetadataResult =
      __gh_codegen.game_of_life$v0_1$types$WorldMetadata;

    export interface InitializeArgs {
      seed: bigint;
      size: bigint;
      resizable: boolean;
    }
    export type InitializeResult =
      __gh_codegen.game_of_life$v0_1$types$WorldMetadata;

    export interface ResizeArgs {
      size: bigint;
    }
    export type ResizeResult =
      __gh_codegen.game_of_life$v0_1$types$WorldMetadata;

    export type DeclaredException = {
      kind: "declared";
      name: "GameOfLifeError";
      selector: 0x63bf848a696f21bfn;
      value: __gh_codegen.game_of_life$v0_1$types$GameOfLifeError;
    };
    export type Exception =
      __gh_client_contract.ContractException<DeclaredException>;
  }
}

export const spec: __gh_client_contract.ContractSpec = {
  interfaces: [
    {
      name: __gh_s("GameOfLife"),
      vers: __gh_s("0.1.0"),
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("game-of-life"),
              major: __gh_s("0.1"),
              module_path: __gh_s("game_of_life::types"),
              declared: __gh_s("GameOfLifeError"),
            },
          },
        },
      ],
      methods: [
        {
          name: __gh_s("advance"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("game-of-life"),
              major: __gh_s("0.1"),
              module_path: __gh_s("game_of_life::types"),
              declared: __gh_s("WorldMetadata"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("get_chunk"),
          args: [
            {
              name: __gh_s("row"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("part"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 1000n,
            },
          },
          effect: null,
        },
        {
          name: __gh_s("get_metadata"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("game-of-life"),
              major: __gh_s("0.1"),
              module_path: __gh_s("game_of_life::types"),
              declared: __gh_s("WorldMetadata"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("initialize"),
          args: [
            {
              name: __gh_s("seed"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
            },
            {
              name: __gh_s("size"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("resizable"),
              ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("game-of-life"),
              major: __gh_s("0.1"),
              module_path: __gh_s("game_of_life::types"),
              declared: __gh_s("WorldMetadata"),
            },
          },
          effect: null,
        },
        {
          name: __gh_s("resize"),
          args: [
            {
              name: __gh_s("size"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Named,
            named: {
              crate_name: __gh_s("game-of-life"),
              major: __gh_s("0.1"),
              module_path: __gh_s("game_of_life::types"),
              declared: __gh_s("WorldMetadata"),
            },
          },
          effect: null,
        },
      ],
    },
  ],
  type_defs: [
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefEnum,
      enum_def: {
        name: {
          crate_name: __gh_s("game-of-life"),
          major: __gh_s("0.1"),
          module_path: __gh_s("game_of_life::types"),
          declared: __gh_s("GameOfLifeError"),
        },
        variants: [
          { name: __gh_s("AlreadyInitialized"), value: 1n },
          { name: __gh_s("NotInitialized"), value: 2n },
          { name: __gh_s("InvalidWorldSize"), value: 3n },
          { name: __gh_s("FixedWorld"), value: 4n },
          { name: __gh_s("ChunkOutOfBounds"), value: 5n },
          { name: __gh_s("GenerationOverflow"), value: 6n },
          { name: __gh_s("EpochOverflow"), value: 7n },
          { name: __gh_s("InvalidStoredState"), value: 8n },
        ],
      },
    },
    {
      v: __gh_contract_spec.ContractTypeDefKind.TypeDefStruct,
      struct_def: {
        name: {
          crate_name: __gh_s("game-of-life"),
          major: __gh_s("0.1"),
          module_path: __gh_s("game_of_life::types"),
          declared: __gh_s("WorldMetadata"),
        },
        fields: [
          {
            name: __gh_s("epoch"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
          },
          {
            name: __gh_s("size"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("generation"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
          },
          {
            name: __gh_s("seed"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
          },
          {
            name: __gh_s("population"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
          },
          {
            name: __gh_s("state_digest"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("resizable"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Bool },
          },
        ],
      },
    },
  ],
  events: [
    {
      name: {
        crate_name: __gh_s("game-of-life"),
        major: __gh_s("0.1"),
        module_path: __gh_s("game_of_life::types"),
        declared: __gh_s("GenerationAdvanced"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "2657b6acef30bda5e51a6887b046b5cdae053ba640a9795786e0d727304128a6",
        ),
      ),
      topics: [
        {
          name: __gh_s("advanced_by"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("epoch"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("generation"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("population"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("state_digest"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
    {
      name: {
        crate_name: __gh_s("game-of-life"),
        major: __gh_s("0.1"),
        module_path: __gh_s("game_of_life::types"),
        declared: __gh_s("WorldInitialized"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "aeee0b8f32b14094ec3c214bd9415a7a99476144e3ae41db2a019b58d4ee55e0",
        ),
      ),
      topics: [],
      fields: [
        {
          name: __gh_s("epoch"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("size"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
        },
        {
          name: __gh_s("seed"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("population"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
        },
        {
          name: __gh_s("state_digest"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
      ],
    },
  ],
};

const __gh_codecs = __gh_client_contract.createContractCodecContext(
  spec.type_defs,
);

export const GameOfLife = {
  v0_1: {
    advance: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.AdvanceArgs,
      GameOfLife.v0_1.AdvanceResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "advance",
      publicName: "advance",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.advance,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[0]!.return_type,
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          name: "GameOfLifeError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getChunk: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.GetChunkArgs,
      GameOfLife.v0_1.GetChunkResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "get_chunk",
      publicName: "getChunk",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.getChunk,
      effect: spec.interfaces[0]!.methods[1]!.effect,
      args: [
        {
          abiName: "row",
          publicName: "row",
          type: spec.interfaces[0]!.methods[1]!.args[0]!.ty,
        },
        {
          abiName: "part",
          publicName: "part",
          type: spec.interfaces[0]!.methods[1]!.args[1]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[1]!.return_type,
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          name: "GameOfLifeError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    getMetadata: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.GetMetadataArgs,
      GameOfLife.v0_1.GetMetadataResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "get_metadata",
      publicName: "getMetadata",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.getMetadata,
      effect: spec.interfaces[0]!.methods[2]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[2]!.return_type,
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          name: "GameOfLifeError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    initialize: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.InitializeArgs,
      GameOfLife.v0_1.InitializeResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "initialize",
      publicName: "initialize",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.initialize,
      effect: spec.interfaces[0]!.methods[3]!.effect,
      args: [
        {
          abiName: "seed",
          publicName: "seed",
          type: spec.interfaces[0]!.methods[3]!.args[0]!.ty,
        },
        {
          abiName: "size",
          publicName: "size",
          type: spec.interfaces[0]!.methods[3]!.args[1]!.ty,
        },
        {
          abiName: "resizable",
          publicName: "resizable",
          type: spec.interfaces[0]!.methods[3]!.args[2]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[3]!.return_type,
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          name: "GameOfLifeError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
    resize: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.ResizeArgs,
      GameOfLife.v0_1.ResizeResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "resize",
      publicName: "resize",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.resize,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [
        {
          abiName: "size",
          publicName: "size",
          type: spec.interfaces[0]!.methods[4]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[4]!.return_type,
      throws: [
        {
          selector: 0x63bf848a696f21bfn,
          name: "GameOfLifeError",
          type: spec.interfaces[0]!.throws[0]!.ty,
        },
      ],
      codecs: __gh_codecs,
    }),
  },
} as const;

export const game_of_life = {
  v0_1: {
    types: {
      GameOfLifeError: {
        AlreadyInitialized: 1n,
        NotInitialized: 2n,
        InvalidWorldSize: 3n,
        FixedWorld: 4n,
        ChunkOutOfBounds: 5n,
        GenerationOverflow: 6n,
        EpochOverflow: 7n,
        InvalidStoredState: 8n,
      },
      GenerationAdvanced: __gh_client_contract.defineContractEvent<
        "GenerationAdvanced",
        game_of_life.v0_1.types.GenerationAdvanced["topics"],
        game_of_life.v0_1.types.GenerationAdvanced["fields"],
        game_of_life.v0_1.types.GenerationAdvancedFilter
      >({
        name: "GenerationAdvanced",
        signature: spec.events[0]!.signature,
        topics: [
          {
            name: "advanced_by",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "address",
          },
        ],
        fields: [
          { name: "epoch", type: spec.events[0]!.fields[0]!.ty },
          { name: "generation", type: spec.events[0]!.fields[1]!.ty },
          { name: "population", type: spec.events[0]!.fields[2]!.ty },
          { name: "state_digest", type: spec.events[0]!.fields[3]!.ty },
        ],
        codecs: __gh_codecs,
      }),
      WorldInitialized: __gh_client_contract.defineContractEvent<
        "WorldInitialized",
        game_of_life.v0_1.types.WorldInitialized["topics"],
        game_of_life.v0_1.types.WorldInitialized["fields"],
        game_of_life.v0_1.types.WorldInitializedFilter
      >({
        name: "WorldInitialized",
        signature: spec.events[1]!.signature,
        topics: [],
        fields: [
          { name: "epoch", type: spec.events[1]!.fields[0]!.ty },
          { name: "size", type: spec.events[1]!.fields[1]!.ty },
          { name: "seed", type: spec.events[1]!.fields[2]!.ty },
          { name: "population", type: spec.events[1]!.fields[3]!.ty },
          { name: "state_digest", type: spec.events[1]!.fields[4]!.ty },
        ],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type GameOfLifeEvent =
  | game_of_life.v0_1.types.GenerationAdvanced
  | game_of_life.v0_1.types.WorldInitialized;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): GameOfLifeEvent | null {
  return (
    game_of_life.v0_1.types.GenerationAdvanced.decode(__gh_event) ??
    game_of_life.v0_1.types.WorldInitialized.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type game_of_life$v0_1$types$GameOfLifeError =
    game_of_life.v0_1.types.GameOfLifeError;
  export type game_of_life$v0_1$types$WorldMetadata =
    game_of_life.v0_1.types.WorldMetadata;
}
