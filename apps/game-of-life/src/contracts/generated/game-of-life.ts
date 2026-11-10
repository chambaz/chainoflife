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
      getCell: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("262db49c7562de71"),
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
      processNextTick: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("715970538707ce84"),
      ),
      requestTick: __gh_protocol.contractEntrypointID(
        __gh_protocol_utils.fromHex("abf7742c292ca352"),
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
      export type GameOfLifeError =
        1n | 2n | 3n | 4n | 5n | 6n | 7n | 8n | 9n | 10n;

      export interface TickResult {
        request_id: __gh_client_contract.FixedBytes<32>;
        requested_by: __gh_protocol.ContractAddress;
        metadata: __gh_codegen.game_of_life$v0_1$types$WorldMetadata;
      }

      export interface WorldMetadata {
        epoch: bigint;
        width: bigint;
        height: bigint;
        generation: bigint;
        seed: bigint;
        population: bigint;
        state_digest: __gh_client_contract.FixedBytes<32>;
        chunk_bytes: bigint;
        chunks_per_row: bigint;
        max_queue_len: bigint;
      }

      export interface GenerationAdvanced extends __gh_client_contract.DecodedContractEvent<
        "GenerationAdvanced",
        { request_id: __gh_client_contract.FixedBytes<32> },
        {
          epoch: bigint;
          generation: bigint;
          requested_by: __gh_protocol.ContractAddress;
          population: bigint;
          state_digest: __gh_client_contract.FixedBytes<32>;
        }
      > {}

      export interface GenerationAdvancedFilter {
        request_id?: __gh_client_contract.ContractEventFilterValue<
          __gh_client_contract.FixedBytes<32>
        >;
      }

      export interface TickRequested extends __gh_client_contract.DecodedContractEvent<
        "TickRequested",
        {
          request_id: __gh_client_contract.FixedBytes<32>;
          requested_by: __gh_protocol.ContractAddress;
        },
        { epoch: bigint }
      > {}

      export interface TickRequestedFilter {
        request_id?: __gh_client_contract.ContractEventFilterValue<
          __gh_client_contract.FixedBytes<32>
        >;
        requested_by?: __gh_client_contract.ContractEventFilterValue<__gh_protocol.ContractAddress>;
      }

      export interface WorldInitialized extends __gh_client_contract.DecodedContractEvent<
        "WorldInitialized",
        {},
        {
          epoch: bigint;
          size: bigint;
          seed: bigint;
          max_queue_len: bigint;
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
    export interface GetCellArgs {
      x: bigint;
      y: bigint;
    }
    export type GetCellResult = boolean;

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
      maxQueueLen: bigint;
    }
    export type InitializeResult =
      __gh_codegen.game_of_life$v0_1$types$WorldMetadata;

    export type ProcessNextTickArgs = void;
    export type ProcessNextTickResult =
      __gh_codegen.game_of_life$v0_1$types$TickResult | null;

    export type RequestTickArgs = void;
    export type RequestTickResult = __gh_client_contract.FixedBytes<32>;

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
          name: __gh_s("get_cell"),
          args: [
            {
              name: __gh_s("x"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
            {
              name: __gh_s("y"),
              ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
            },
          ],
          return_type: { v: __gh_contract_spec.ContractTypeKind.Bool },
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
              name: __gh_s("max_queue_len"),
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
        {
          name: __gh_s("process_next_tick"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Option,
            option_inner: {
              v: __gh_contract_spec.ContractTypeKind.Named,
              named: {
                crate_name: __gh_s("game-of-life"),
                major: __gh_s("0.1"),
                module_path: __gh_s("game_of_life::types"),
                declared: __gh_s("TickResult"),
              },
            },
          },
          effect: null,
        },
        {
          name: __gh_s("request_tick"),
          args: [],
          return_type: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
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
          { name: __gh_s("CoordinateOutOfBounds"), value: 3n },
          { name: __gh_s("ChunkOutOfBounds"), value: 4n },
          { name: __gh_s("GenerationOverflow"), value: 5n },
          { name: __gh_s("InvalidStoredState"), value: 6n },
          { name: __gh_s("InvalidQueueCapacity"), value: 7n },
          { name: __gh_s("InvalidWorldSize"), value: 8n },
          { name: __gh_s("PendingRequests"), value: 9n },
          { name: __gh_s("EpochOverflow"), value: 10n },
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
          declared: __gh_s("TickResult"),
        },
        fields: [
          {
            name: __gh_s("request_id"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Array,
              array: {
                element: { v: __gh_contract_spec.ContractTypeKind.U8 },
                len: 32n,
              },
            },
          },
          {
            name: __gh_s("requested_by"),
            ty: { v: __gh_contract_spec.ContractTypeKind.Address },
          },
          {
            name: __gh_s("metadata"),
            ty: {
              v: __gh_contract_spec.ContractTypeKind.Named,
              named: {
                crate_name: __gh_s("game-of-life"),
                major: __gh_s("0.1"),
                module_path: __gh_s("game_of_life::types"),
                declared: __gh_s("WorldMetadata"),
              },
            },
          },
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
            name: __gh_s("width"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("height"),
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
            name: __gh_s("chunk_bytes"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("chunks_per_row"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
          },
          {
            name: __gh_s("max_queue_len"),
            ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
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
          name: __gh_s("request_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
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
          name: __gh_s("requested_by"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
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
        declared: __gh_s("TickRequested"),
      },
      signature: __gh_protocol.topic(
        __gh_protocol_utils.fromHex(
          "1aa07f416db4c821d936f47b626fb0bde1168442d6c384fc9f1aef75b93ada37",
        ),
      ),
      topics: [
        {
          name: __gh_s("request_id"),
          ty: {
            v: __gh_contract_spec.ContractTypeKind.Array,
            array: {
              element: { v: __gh_contract_spec.ContractTypeKind.U8 },
              len: 32n,
            },
          },
        },
        {
          name: __gh_s("requested_by"),
          ty: { v: __gh_contract_spec.ContractTypeKind.Address },
        },
      ],
      fields: [
        {
          name: __gh_s("epoch"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U64 },
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
          name: __gh_s("max_queue_len"),
          ty: { v: __gh_contract_spec.ContractTypeKind.U32 },
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
    getCell: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.GetCellArgs,
      GameOfLife.v0_1.GetCellResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "get_cell",
      publicName: "getCell",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.getCell,
      effect: spec.interfaces[0]!.methods[0]!.effect,
      args: [
        {
          abiName: "x",
          publicName: "x",
          type: spec.interfaces[0]!.methods[0]!.args[0]!.ty,
        },
        {
          abiName: "y",
          publicName: "y",
          type: spec.interfaces[0]!.methods[0]!.args[1]!.ty,
        },
      ],
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
          abiName: "max_queue_len",
          publicName: "maxQueueLen",
          type: spec.interfaces[0]!.methods[3]!.args[1]!.ty,
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
    processNextTick: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.ProcessNextTickArgs,
      GameOfLife.v0_1.ProcessNextTickResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "process_next_tick",
      publicName: "processNextTick",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.processNextTick,
      effect: spec.interfaces[0]!.methods[4]!.effect,
      args: [],
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
    requestTick: __gh_client_contract.defineContractMethod<
      GameOfLife.v0_1.RequestTickArgs,
      GameOfLife.v0_1.RequestTickResult,
      GameOfLife.v0_1.DeclaredException
    >({
      interfaceName: "GameOfLife",
      interfaceVersion: "0.1.0",
      abiName: "request_tick",
      publicName: "requestTick",
      entrypoint: __gh_entrypoints.GameOfLife.v0_1.requestTick,
      effect: spec.interfaces[0]!.methods[5]!.effect,
      args: [],
      returnType: spec.interfaces[0]!.methods[5]!.return_type,
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
      effect: spec.interfaces[0]!.methods[6]!.effect,
      args: [
        {
          abiName: "size",
          publicName: "size",
          type: spec.interfaces[0]!.methods[6]!.args[0]!.ty,
        },
      ],
      returnType: spec.interfaces[0]!.methods[6]!.return_type,
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
        CoordinateOutOfBounds: 3n,
        ChunkOutOfBounds: 4n,
        GenerationOverflow: 5n,
        InvalidStoredState: 6n,
        InvalidQueueCapacity: 7n,
        InvalidWorldSize: 8n,
        PendingRequests: 9n,
        EpochOverflow: 10n,
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
            name: "request_id",
            type: spec.events[0]!.topics[0]!.ty,
            representation: "fixedBytes32",
          },
        ],
        fields: [
          { name: "epoch", type: spec.events[0]!.fields[0]!.ty },
          { name: "generation", type: spec.events[0]!.fields[1]!.ty },
          { name: "requested_by", type: spec.events[0]!.fields[2]!.ty },
          { name: "population", type: spec.events[0]!.fields[3]!.ty },
          { name: "state_digest", type: spec.events[0]!.fields[4]!.ty },
        ],
        codecs: __gh_codecs,
      }),
      TickRequested: __gh_client_contract.defineContractEvent<
        "TickRequested",
        game_of_life.v0_1.types.TickRequested["topics"],
        game_of_life.v0_1.types.TickRequested["fields"],
        game_of_life.v0_1.types.TickRequestedFilter
      >({
        name: "TickRequested",
        signature: spec.events[1]!.signature,
        topics: [
          {
            name: "request_id",
            type: spec.events[1]!.topics[0]!.ty,
            representation: "fixedBytes32",
          },
          {
            name: "requested_by",
            type: spec.events[1]!.topics[1]!.ty,
            representation: "address",
          },
        ],
        fields: [{ name: "epoch", type: spec.events[1]!.fields[0]!.ty }],
        codecs: __gh_codecs,
      }),
      WorldInitialized: __gh_client_contract.defineContractEvent<
        "WorldInitialized",
        game_of_life.v0_1.types.WorldInitialized["topics"],
        game_of_life.v0_1.types.WorldInitialized["fields"],
        game_of_life.v0_1.types.WorldInitializedFilter
      >({
        name: "WorldInitialized",
        signature: spec.events[2]!.signature,
        topics: [],
        fields: [
          { name: "epoch", type: spec.events[2]!.fields[0]!.ty },
          { name: "size", type: spec.events[2]!.fields[1]!.ty },
          { name: "seed", type: spec.events[2]!.fields[2]!.ty },
          { name: "max_queue_len", type: spec.events[2]!.fields[3]!.ty },
          { name: "population", type: spec.events[2]!.fields[4]!.ty },
          { name: "state_digest", type: spec.events[2]!.fields[5]!.ty },
        ],
        codecs: __gh_codecs,
      }),
    },
  },
} as const;

export type GameOfLifeEvent =
  | game_of_life.v0_1.types.GenerationAdvanced
  | game_of_life.v0_1.types.TickRequested
  | game_of_life.v0_1.types.WorldInitialized;

export function decodeEvent(__gh_event: {
  topics: globalThis.Uint8Array[];
  data: globalThis.Uint8Array;
}): GameOfLifeEvent | null {
  return (
    game_of_life.v0_1.types.GenerationAdvanced.decode(__gh_event) ??
    game_of_life.v0_1.types.TickRequested.decode(__gh_event) ??
    game_of_life.v0_1.types.WorldInitialized.decode(__gh_event)
  );
}

// The types the namespaces above refer to, under names no declaration can capture.
export namespace __gh_codegen {
  export type game_of_life$v0_1$types$GameOfLifeError =
    game_of_life.v0_1.types.GameOfLifeError;
  export type game_of_life$v0_1$types$TickResult =
    game_of_life.v0_1.types.TickResult;
  export type game_of_life$v0_1$types$WorldMetadata =
    game_of_life.v0_1.types.WorldMetadata;
}
