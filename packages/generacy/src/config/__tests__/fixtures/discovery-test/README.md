# Discovery Test Fixture

This directory structure is used for testing the config file discovery algorithm.

## Structure

```
discovery-test/
├── .generacy/
│   └── config.yaml          # Config file at root
├── nested/
│   └── deep/                # Test discovery from deeply nested directory
└── README.md
```

## Usage

Tests should:
1. Start from `nested/deep/` directory
2. Walk up to find `.generacy/config.yaml`
3. Verify correct config is loaded

This tests that the discovery algorithm correctly walks up the directory tree
to find the config file in parent directories.
