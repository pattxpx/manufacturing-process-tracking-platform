"""Fixed reference data: production steps, statuses and the (fictional) product catalog."""

# The five production steps, in the only order they may happen.
STEPS = ["design_review", "printing", "post_processing", "quality_inspection", "final_release"]

STEP_LABELS = {
    "design_review": "Design Review",
    "printing": "3D Printing",
    "post_processing": "Post-processing",
    "quality_inspection": "Quality Inspection",
    "final_release": "Final Release",
}

# Steps that an operator starts and completes on the production board.
# Quality inspection is completed by recording a Pass result; release has its own endpoint.
BOARD_STEPS = ["design_review", "printing", "post_processing"]

# Order statuses
NEW = "new"                            # created, no step started yet
IN_PRODUCTION = "in_production"        # between design review and post-processing
AWAITING_QC = "awaiting_qc"            # post-processing done, waiting for inspection
QC_FAILED = "qc_failed"                # latest inspection failed
READY_FOR_RELEASE = "ready_for_release"  # inspection passed
RELEASED = "released"
ORDER_STATUSES = [NEW, IN_PRODUCTION, AWAITING_QC, QC_FAILED, READY_FOR_RELEASE, RELEASED]

# Fictional products. "materials" maps a material name to how much ONE unit of the product needs
# (in that material's unit). Most products use one material; two use several.
PRODUCTS = {
    "Titanium Spinal Cage": {"materials": {"Ti-6Al-4V Powder": 40}},
    "Cranial Implant Plate": {"materials": {"Ti-6Al-4V Powder": 120, "Argon Gas": 12}},
    "Orthopedic Knee Insert": {"materials": {"PA12 Medical Nylon Powder": 85}},
    "Custom Surgical Guide": {"materials": {"Medical Photopolymer Resin": 60, "Isopropyl Alcohol": 20}},
    "Hearing Aid Shell": {"materials": {"Medical Photopolymer Resin": 8}},
}

# Materials: unit and starting stock (used by the seed script and the migration).
MATERIALS = {
    "Ti-6Al-4V Powder": {"unit": "g", "stock": 20000, "category": "powder", "min_stock": 3000},
    "PA12 Medical Nylon Powder": {"unit": "g", "stock": 15000, "category": "powder", "min_stock": 2000},
    "Medical Photopolymer Resin": {"unit": "ml", "stock": 10000, "category": "resin", "min_stock": 1500},
    "Argon Gas": {"unit": "L", "stock": 6000, "category": "gas", "min_stock": 1000},  # inert gas for metal printing
    "Isopropyl Alcohol": {"unit": "ml", "stock": 12000, "category": "solvent", "min_stock": 2000},  # wash for resin parts
}
